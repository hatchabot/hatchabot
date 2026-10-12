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

### macOS: setup says it installed the service, but Hatchabot never starts (the install folder's path has `&`, `<` or a quote in it)
- **Check:** `plutil -lint ~/Library/LaunchAgents/com.hatchabot.control-plane.plist` reports a parse error, and `launchctl list com.hatchabot.control-plane` finds nothing; the install folder's path has `&`, `<`, `>` or `"` in it (the backup job, `com.hatchabot.backup.plist`, is the same).
- **Cause:** setup-host.sh pasted the folder's path into the launchd files as it was, so an `&` made a file launchd cannot read, and a quote or `$` in the path broke the job's command.
- **Fix:** upgrade and run `./scripts/setup-host.sh` again (it keeps `.env`): the files are now written with the path escaped, and the job is given the folder as an argument. On older releases, move the install to a folder whose path has none of those characters.
- **Fixed in:** `v2.162.0`
- **Code:** `scripts/launchd-plist.sh` — `xml`; `scripts/setup-host.sh` — `launchd`

### An upgrade that took over an hour broke the install, or "Another upgrade … is running" never goes away
- **Check:** the upgrade's log shows two `Upgrading …` lines overlapping (a slow download, then the channel timer or a hand-run upgrade); or `ls ~/.local/state/hatchabot/upgrade-*.lock.d` exists while no upgrade runs, and its `owner` file names a process that `ps -p <pid>` no longer shows.
- **Cause:** the upgrade lock was judged by age alone: after an hour the next run removed it even though the first upgrade was still downloading, and both swapped the code at once.
- **Fix:** upgrade, then run `hatchabot upgrade` again if the tree was left mixed (the previous release is put back on failure). The lock now names its holder: a running upgrade keeps it however long it takes, and one whose holder is gone is cleared at once. A lock with no `owner` file is still cleared after an hour.
- **Fixed in:** `v2.162.0`
- **Code:** `scripts/upgrade.sh` — `lock_left_over`, `take_lock`; `scripts/deploy-release.sh` — `lock_left_over`

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

### Restart says "Service was restarted but isn't answering on port …" while the app works, and the upgrade rolls back
- **Check:** `.env` sets `HATCHABOT_TLS_CERT` (the service serves HTTPS itself) or `HATCHABOT_BIND` to one address; `curl -k https://localhost:<PORT>/healthz` (or `http://<bind address>:<PORT>/healthz`) answers.
- **Cause:** before v2.162.0, `scripts/restart.sh` always asked `http://localhost:<PORT>/healthz`, which a native-TLS listener or one bound to another address never answers; the upgrade took that as a failed release and rolled it back.
- **Fix:** upgrade (the upgrade restarts with the new release's script, so this upgrade is not rolled back). The probe now uses https when TLS is set and the bind address when it is one host.
- **Fixed in:** `v2.162.0`
- **Code:** `scripts/restart.sh` — `LISTENER`

### The follow-latest timer says "Not deploying vX.Y.Z" for a new tag
- **Check:** `journalctl --user -u hatchabot-follow-latest` gives the reason; `curl -s https://api.github.com/repos/hatchabot/hatchabot/releases/tags/vX.Y.Z` shows the release (`"immutable": true`, a `release-manifest.json` asset), and `git -C ~/hatchabot-prod rev-parse vX.Y.Z^{commit}` is the manifest's `commit`.
- **Cause:** from v2.160.0 the timer deploys a v2.159.0-or-later tag only when it is a published, immutable release whose manifest is for that tag and names its commit. "Not a published release yet" is normal for a few minutes after tagging, while the release workflow runs. A manifest for another commit, a release that is not immutable, or one with no manifest means the tag did not come from the release workflow.
- **Fix:** for "not published yet", wait, or see why the release workflow stopped (`gh run list -w release.yml`). For a refused tag, do not deploy it by hand: find out who made it. After fixing, `rm ~/.local/state/hatchabot/follow-latest-failed` to let the timer look again.
- **Fixed in:** `v2.160.0` (#37)
- **Code:** `scripts/follow-latest.sh` — `verify_release`

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

### Privacy check: "✗ incomplete: the database … is not there" (exit 3) and the push or release stops
- **Check:** `node scripts/privacy-check.mjs --text CHANGELOG.md` prints `✗ incomplete:` lines.
- **Cause:** an env file was found but the database (`HATCHABOT_DB`) wasn't, or it has no agents/accounts table, or a `--env` file is missing; before, this passed on partial values.
- **Fix:** point `HATCHABOT_DB` (or `--db`) at the install's database and pass only `--env` files that exist.
- **Fixed in:** `v2.158.3`
- **Code:** `scripts/privacy-check.mjs` — `load`, `privateValues`

### The `privacy` live test fails with "release notes: GitHub did not answer" or "no gh command here"
- **Check:** `gh auth status`; the output has `✗ incomplete:` lines.
- **Cause:** `--public` can't read release notes or issues; this used to print SKIP and pass, now it fails.
- **Fix:** install `gh` and `gh auth login`, then `node scripts/live.mjs run privacy`.
- **Fixed in:** `v2.158.3`
- **Code:** `scripts/privacy-check.mjs` — `publicScan`

### The `privacy` live test fails with "✗ pre-push hook: …"
- **Check:** `node scripts/privacy-check.mjs --check-hook`.
- **Cause:** this checkout's pre-push doesn't run the privacy check: not installed, a `core.hooksPath` folder whose pre-push doesn't hand on to the repo's hook, or hooks off.
- **Fix:** `node scripts/privacy-check.mjs --install-hook`; with a machine-wide hooks folder, its pre-push must run `$(git rev-parse --git-common-dir)/hooks/pre-push`.
- **Fixed in:** `v2.158.3`
- **Code:** `scripts/privacy-check.mjs` — `hookStatus`

### CI's `privacy` job names a value at `file (commit <sha>)` that the change no longer has, or says "✗ incomplete: … git could not read it"
- **Check:** the job's log; `git show <sha>` shows the value added in that commit and taken out by a later one.
- **Cause:** the job read only the change's end result, so a value added in one commit and removed in the next passed while staying public in the history; and a git command that failed read as an empty, clean change (a branch's first commit always did).
- **Fix:** for a hit, rewrite the branch so no commit carries the value (squash or amend it out), then push again. For incomplete, re-run the job; a range of more than 1,000 commits is split into smaller pull requests.
- **Fixed in:** `v2.162.0`
- **Code:** `scripts/privacy-ci.mjs` — `scanRange`, `numstatFiles`

### `Privacy watch` fails on an old release's notes
- **Check:** the hit says `release v… body`, for a release published long before the watch's two days.
- **Cause:** release notes were judged by the date the release was published, so an edit to an old release's notes was never read; GitHub keeps no date a release was last edited, so now every release note is read each day.
- **Fix:** edit that release's notes on GitHub to use a made-up value, then run the watch again by hand.
- **Fixed in:** `v2.162.0`
- **Code:** `scripts/privacy-ci.mjs` — `watchMain`

### The installer or an upgrade says the bundle does not match the release's manifest
- **Check:** `scripts/release-manifest.sh asset vX.Y.Z <downloaded bundle> hatchabot-vX.Y.Z-<platform>.tar.gz` says it does not match; compare `wc -c` and `sha256sum` of the download with the manifest's entry. The installer says "the bundle does not match the release's manifest — not using it"; an upgrade says "the release's manifest does not vouch for it" and exits 3.
- **Cause:** the downloaded bundle is not the one the release vouched for: a truncated or altered download, or a proxy rewriting it.
- **Fix:** run the installer or `hatchabot upgrade` again, from another network if it repeats. If it still differs, report it; do not bypass the check. The installer has already fallen back to the native install.
- **Fixed in:** `v2.159.0` (#38)
- **Code:** `install.sh` — `install_bundle`, `mf_matches`; `scripts/release-manifest.sh` — `asset`

### The release's manifest is "not a readable manifest" and is refused
- **Check:** `curl -sSL https://github.com/hatchabot/hatchabot/releases/download/vX.Y.Z/release-manifest.json | head` shows a sign-in page, a proxy's page, or a different `"tag"`.
- **Cause:** what came back was not that release's manifest (a captive portal, a proxy, or the wrong file). Hatchabot refuses it rather than fall back to the weaker `.sha256` check.
- **Fix:** sign in to the network or go around the proxy, then run it again.
- **Fixed in:** `v2.159.0` (#38)
- **Code:** `scripts/release-manifest.sh` — `load`, `mf_valid`

### "has no release-manifest.json, though every release from v2.159.0 on has one"
- **Check:** `scripts/release-manifest.sh get vX.Y.Z` prints that line and exits 2; `curl -sSI https://github.com/hatchabot/hatchabot/releases/download/vX.Y.Z/release-manifest.json` answers 404. The installer says "release vX.Y.Z has no manifest … not using the bundle"; an upgrade stops with exit 3; Settings → Images or **Install image** says the release has no release manifest.
- **Cause:** a release from v2.159.0 on always carries its manifest, so a 404 means it is missing from where it was fetched: a release still being published, a mirror (`HATCHABOT_BUNDLE_BASE`) without it, or a release that was tampered with. Before v2.160.0 any 404 was taken as an old release, and the `.sha256` beside the bundle or the image's moveable tag was trusted instead.
- **Fix:** wait a few minutes and run it again (a release being published); with a mirror, copy the release's `release-manifest.json` to it. If GitHub's release page has no manifest, report it; do not work around the check. `BUILD_LOCAL=1 ./scripts/build-runtime-image.sh` builds the runtime image here without trusting anything published.
- **Fixed in:** `v2.160.0`
- **Code:** `scripts/release-manifest.sh` — `mf_required`, `load`; `install.sh` — `install_bundle`; `src/orchestrator/releaseManifest.ts` — `manifestRequired`, `releaseManifest`

### "Could not fetch the release's manifest" during an install, upgrade or image pull
- **Check:** `curl -sSI` of the manifest's address fails, or answers something other than 200 or 404.
- **Cause:** no network to GitHub, or a server error. Only a 404 means "this release has no manifest", and only for a release from before manifests (before v2.159.0); anything else is refused, never skipped.
- **Fix:** try again later; an upgrade retries on its own (exit 3). An image pull for a release whose manifest was kept on this machine works offline.
- **Fixed in:** `v2.159.0` (#38)
- **Code:** `scripts/release-manifest.sh` — `mf_fetch`; `src/orchestrator/releaseManifest.ts` — `releaseManifest`

### The published runtime image is refused: its OpenClaw version is not the manifest's
- **Check:** `scripts/release-manifest.sh image vX.Y.Z`, then `docker inspect <that reference> --format '{{ index .Config.Labels "org.agentclaw.openclaw-version" }}'`.
- **Cause:** the image at the manifest's digest does not carry the OpenClaw version the manifest names, or the manifest itself was refused. Either way Hatchabot will not use the published image.
- **Fix:** `BUILD_LOCAL=1 ./scripts/build-runtime-image.sh` builds it from source; report the release.
- **Fixed in:** `v2.159.0` (#47)
- **Code:** `scripts/build-runtime-image.sh` — `use_pulled`; `src/orchestrator/releaseManifest.ts` — `publishedRuntimeImage`

### Install image on a runner says there is no published image of this version to pull
- **Check:** this machine's `hatchabot-runtime:latest` carries a different OpenClaw version than the release's manifest names (a candidate OpenClaw).
- **Cause:** a runner with another CPU can only take the published image the release vouches for, and a candidate OpenClaw has none.
- **Fix:** build the image on the runner itself, or use the release's own OpenClaw version on that runner.
- **Fixed in:** `v2.159.0` (#47)
- **Code:** `src/orchestrator/runnerSetup.ts` — `installRuntimeImage`

### Promote says "Moving the image :stable failed" (or :beta)
- **Check:** open the run address in the message; promote-images.yml says why: no manifest, no attestation, `:vX.Y.Z` names another digest, or "newer than … needs allow_backwards".
- **Cause:** the channel moved but the image alias did not (a registry error, a release from before manifests, or a backwards move that was not a rollback).
- **Fix:** fix the cause, then `gh run rerun <id> --failed`, or `gh workflow run promote-images.yml --ref main -f version=X.Y.Z -f alias=stable [-f allow_backwards=true]`.
- **Fixed in:** `v2.159.0` (#47)
- **Code:** `scripts/promote.sh` — `promote_images`

### A setting saved in the app is gone again, although the save said it worked
- **Check:** two settings were saved close together (Settings → Hosts → Defaults, rebuild policy, backup drills, public access); `grep HATCHABOT_<NAME> .env` lacks one of them. A leftover `.env.tmp` beside `.env` is a sign of the same race.
- **Cause:** each save read the whole `.env`, changed its line and renamed a shared `.env.tmp` over the file; two saves at once each wrote their own snapshot, so the later one put back the other's old value (or renamed the other's half-written copy).
- **Fix:** upgrade, then save the missing setting again. Saves to one `.env` now run one at a time, each through its own staging file; a stale `.env.tmp` can be deleted.
- **Fixed in:** `v2.160.0` (#160)
- **Code:** `src/config/envFile.ts` — `withEnvFileLock`, `replaceEnvFile`; `src/ops/tailnet.ts` — `writeEnvVar`, `unsetEnvVar`

### The log says `env.sync_refused` "… has a value on more than one line"
- **Check:** `.env` has a value in quotes that continues on the next line (`NAME="first` / `second"`) or a line ending in `\`.
- **Cause:** at each start Hatchabot puts `.env` in order line by line. Before v2.160.0 it moved the continuation line under "Other settings", which changed that value while the tidy reported it safe.
- **Fix:** nothing is lost: the file is now left exactly as it is. To have it tidied, put the value on one line. If an older release already split one, put its lines back together from the newest `.env.bak-*` copy.
- **Fixed in:** `v2.160.0` (#79)
- **Code:** `src/config/envFile.ts` — `multilineSetting`, `syncEnvText`

### On a Mac, a setting in `.env` went back to an older value after a start (the log may say `env.sync_refused` "would change …")
- **Check:** `.env` sets the same name twice, once as `export NAME=…` and once as plain `NAME=…`, the plain one lower down.
- **Cause:** at each start Hatchabot puts `.env` in order and moves lines it does not understand, such as `export …`, under "Other settings" at the end. The macOS launcher reads the file as a shell does, where the last line wins, so the old `export` line took over again.
- **Fix:** upgrade: such a file is now left as it is, with `env.sync_refused` naming the setting. Remove the `export` line you no longer want (or the word `export`). If an older release already reordered it, the newest `.env.bak-*` copy has the order as you wrote it.
- **Fixed in:** `v2.162.0`
- **Code:** `src/config/envFile.ts` — `sourcedValues`, `syncEnvText`

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

### Google sign-in says "Your login could not be verified — try signing in again." just after a restart
- **Check:** the install uses `HATCHABOT_AUTH=identity`; it happened within a minute of the service starting (or of Google rotating its keys), while someone else, or another tab, was signing in too; trying again a moment later works.
- **Cause:** the first sign-in fetched Google's signing certificates, and the once-a-minute limit on that fetch sent every other sign-in arriving meanwhile straight to the still-empty cache, where it was refused.
- **Fix:** upgrade; sign-ins that arrive during the fetch wait for it (still one request to Google). On an older version, sign in again.
- **Fixed in:** `v2.162.0`
- **Code:** `src/api/identity.ts` — `IdentityVerifier`

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

### A password reset did not hold: the password chosen with the old one works instead, or "Your password was changed while this was being checked"
- **Check:** the owner reset someone's password (in the app or with `hatchabot accounts reset-password`) while that person was changing it, or making a recovery code, with the old one; the security record and log show both at nearly the same time.
- **Cause:** before v2.162.0 the change checked the old password, then stored the new one without looking again: a reset made during the check was overwritten, so whoever held the old password kept the account (and could mint a recovery code).
- **Fix:** upgrade; a change or a new recovery code is stored only while the password that was checked is still the account's, and otherwise answers "Your password was changed while this was being checked". On an older version, reset the password again and make the person a new recovery code.
- **Fixed in:** `v2.162.0`
- **Code:** `src/api/accountsAuth.ts` — `PASSWORD_CHANGED_MEANWHILE`; `src/store/store.ts` — `setLocalAccountPassword`, `setLocalAccountRecovery`

### After a second-factor reset, an old sign-in at the public address works again without the new factor
- **Check:** after the owner reset someone's factors (`hatchabot second-factor reset <user>`) and that person added a new one, a browser or copied cookie signed in before the reset reaches the public address, or opens a console there, without being asked for the new factor.
- **Cause:** before v2.153.0, the public pass's "second factor given" mark was not tied to the person's set of factors; resetting closed open consoles but the mark counted again once any factor existed.
- **Fix:** upgrade. Passes now carry a factor generation that a reset, a removed factor or a replaced authenticator app moves on, so older proofs ask for the new factor. On an older version, "Sign out on every device" for that person ends the old sign-ins.
- **Fixed in:** `v2.153.0`
- **Code:** `src/api/publicAccess.ts` — `factorAt`, `secondFactorsChanged`; `src/store/store.ts` — `second_factor_generations`

### "That took too long. Start adding the passkey again." or "That passkey did not verify" with Hatchabot open in two tabs
- **Check:** another tab (or window) asked for a passkey, to add one or to sign in, after this one did.
- **Cause:** each person had one pending passkey challenge of each kind, so the second tab's request replaced the first tab's.
- **Fix:** upgrade; each tab's passkey request now stands on its own (up to five at once). On an older version, finish in the tab that asked last, or start again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/secondFactor.ts` — `issue`, `take`; `src/api/webauthn.ts` — `clientDataChallenge`

### A passkey was added after the owner reset that person's second factors
- **Check:** the security record shows `second_factor.reset` for them, then `second_factor.added` (passkey) within a few minutes, without them signing in again.
- **Cause:** a passkey enrolment started before the reset kept its challenge and could finish after it.
- **Fix:** upgrade; a reset (or a removed factor) voids every passkey request begun before it. Reset them again if the passkey is not theirs.
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/secondFactor.ts` — `forgetCeremonies`, `'/v1/second-factor/reset/:id'`

### Public access is on, but the owner has no second factor left
- **Check:** Settings → You lists no passkey or authenticator app for an owner, public access is on, and the security record shows two `second_factor.removed` entries for them seconds apart.
- **Cause:** before v2.162.0, removing a factor checked "is another one left?" before the password check, not after it: two removals sent at once each saw the other factor, and both went through.
- **Fix:** upgrade; the check is made again after the password, with nothing in between it and the removal, so the second request is refused. On an older version, add a factor again at the private address (or turn public access off until you do).
- **Fixed in:** `v2.162.0`
- **Code:** `src/api/secondFactor.ts` — `lastOne`, `'/v1/second-factor/:id'`

### "Make new backup codes" failed, and now neither the old codes nor any new ones work
- **Check:** the request failed (a full disk, say) and Settings → You shows fewer than 10 backup codes, or none of your saved codes is accepted.
- **Cause:** the old codes were deleted before the new ones were stored, one at a time; a failure part-way left only some new codes, which were never shown.
- **Fix:** upgrade; the new set now replaces the old in one step, so a failure keeps your saved codes. On an older version, free the disk and make new codes again (your authenticator app or passkey proves it is you).
- **Fixed in:** `v2.160.0`
- **Code:** `src/store/store.ts` — `replaceBackupCodes`; `src/api/secondFactor.ts` — `newBackupCodes`

### The service log shows an invitation code in a `/v1/agents/<id>/invites/<code>/knock-window` line
- **Check:** `journalctl --user -u hatchabot | grep knock-window` shows the code in full.
- **Cause:** the request log masked the code only in `/join/<code>` and `/v1/invites/<code>`, not on the nested route Copy or Share on an invite calls.
- **Fix:** upgrade; any path segment after `/invites/` is masked. An invite whose code reached a log you share can be removed and made again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/requestLog.ts` — `redactUrlForLog`

### A `request.foreign_refused` log line shows an invitation code
- **Check:** `journalctl --user -u hatchabot | grep foreign_refused` shows a `path` with a code after `/invites/` or `/join/`.
- **Cause:** a request another site's page sent was refused (correctly), but the line saying so logged its path unmasked, unlike the request log.
- **Fix:** upgrade; the refusal is logged with the code masked. An invite whose code reached a log you share can be removed and made again.
- **Fixed in:** `v2.162.0`
- **Code:** `src/api/requestOrigin.ts` — `registerOriginCheck`; `src/api/requestLog.ts` — `redactUrlForLog`

### `hatchabot login` says "(chmod 600)", but `~/.config/hatchabot/env` is readable by other users
- **Check:** `ls -l ~/.config/hatchabot/env` shows `-rw-r--r--` after a `hatchabot login`.
- **Cause:** the file existed before with wider permissions (made by hand, or copied), and the login only set 0600 on a file it created; the token was written into the readable file.
- **Fix:** `chmod 600 ~/.config/hatchabot/env`, and make a new token (⚙ Settings → Security) if others share the machine. From v2.160.0 every write leaves the file 0600.
- **Fixed in:** `v2.160.0`
- **Code:** `src/cli.ts` — `writeConfigValue`

## AI sources and Claude login

### An agent answers "Your model provider needs a new login" or "Not logged in · Please run /login", while the same source works for other agents
- **Check:** the agent's Setup log has `runtime.pins_cleared` after the fix, or, inside the container, `openclaw gateway call sessions.list` shows its sessions pinned to the `claude-cli` runtime.
- **Cause:** OpenClaw pins a runtime per conversation. Agents that once ran through the Claude Code CLI kept that pin after switching to a setup token, and the CLI has no login in the container.
- **Fix:** upgrade, then start or rebuild the agent: pins to runtimes its settings no longer name are cleared at rebuild, start, wake and boot. Do not replace tokens first.
- **Fixed in:** `v2.86.1`
- **Code:** `src/orchestrator/runtimePins.ts` — `clearStaleRuntimePins`; `src/orchestrator/eventLabels.ts` — `runtime.pins_cleared`

### An agent on a machine-login Claude source starts answering through its setup token, or loses its CLI conversation routing, after a slow start
- **Check:** its Setup log has `runtime.pins_cleared` naming `claude-cli`, although its source rides the Claude Code CLI (`openclaw config get agents.defaults.models --json` in its console names `claude-cli`).
- **Cause:** when the agent's config could not be read at that moment (a gateway timeout), it was taken to name no runtime but OpenClaw's own, so valid `claude-cli` pins were cleared as stale.
- **Fix:** upgrade; the next turn on that conversation picks its runtime again from the config. Since v2.160.0 an unreadable config clears nothing (`runtime.pin_check_skipped`) and the next start or rebuild looks again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/runtimePins.ts` — `configuredRuntimes`, `clearStaleRuntimePins`

### Every message fails with "LLM request failed (request format rejected, HTTP 400)" after switching to a newer Claude model (claude-opus-5-5)
- **Check:** the agent's gateway log (`docker logs <container>`) has `claude_code_version_too_old` and "Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required"; the agent runs on a Claude subscription source.
- **Cause:** on a subscription, OpenClaw presents itself to Anthropic as a fixed Claude Code version, and the newest models refuse an old one. OpenClaw 2026.9.6 says 2.1.278; 2026.9.7 and later say 2.1.280. Measured on 2026.9.6: Opus 5.5 is refused; Sonnet 5.5, Fable 5.1 and Sonnet 5 answer. An API-key source is not affected.
- **Fix:** switch the conversation back to a model the source accepts (Sonnet 5 or Opus 4.8) in the chat's model menu, or set the agent's model in Hatchabot. To use the newer model: an agent on OpenClaw 2026.9.7 or later (Settings → Advanced → Runtime images: try a newer image on that agent), or an API-key source. Since v2.137.0 Hatchabot refuses that model for such an agent and says why; a choice in OpenClaw's own chat menu still fails this way.
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

### On a shared AI source, my agent's chosen model changed when the source's owner changed its default
- **Check:** the agent's AI tab still names the model you picked, but it answers as the source's new default; ⚙ Settings → AI shows that model is no longer on the source's list.
- **Cause:** changing a shared source's default (the "apply default model" step) kept your choice stored but left it off the source's model list, and an agent's choice only counts while it is on that list.
- **Fix:** upgrade; the owner's next default change keeps every other member's current choice on the list. Until then, ask the source's owner to add the model back to the list, or pick another one.
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/routes.ts` — `apply-default-model`; `src/orchestrator/provision.ts` — `effectiveModel`

### After switching an agent's AI source, it still uses the old one and no rebuild is offered
- **Check:** the agent's page shows the new source, but its replies (or `openclaw models status` in its console) use the old source, and there is no "rebuild to apply" mark; the model was changed around the same time as the source.
- **Cause:** a model change applied live (`models set`) while the source switch was being saved recorded the new source as applied, although only the old runtime's model had changed.
- **Fix:** rebuild the agent. Since v2.160.0 a live model change records only the settings it applied, so the switch keeps asking for its rebuild.
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/routes.ts` — `applyModelToRuntime`

### Right after switching an agent's AI source, the new source shows "ok" although it refuses the agent
- **Check:** Settings → AI sources shows the new source as working, and the agent's page as answering, while its event log or Usage shows 429 refusals on that source since the switch.
- **Cause:** an agent's last successful call was kept per agent, not per source, so its success on the old source counted as one on the new source and hid the new source's refusals.
- **Fix:** upgrade. Since v2.160.0 a success counts only for the source it was on; the status corrects itself at the next usage reading.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/sourceUsage.ts` — `summarizeSourceUsage`; `src/store/store.ts` — `lastOkOn`

### A save was refused, but part of it changed anyway (an AI source's model, the manager's file limit)
- **Check:** the save answered with an error (for example "Only an Anthropic source can back the management assistant", "can't be shared", "Only the server owner sets the default AI source", or "The manager has no browser"), yet the AI source's default model, or the manager's file-size limit sent with it, changed.
- **Cause:** those checks ran after the first fields of the request had been saved.
- **Fix:** upgrade: a refused save changes nothing. Put the field back by hand if it changed, then save the parts that are allowed on their own.
- **Fixed in:** `v2.160.0` (#56, #57)
- **Code:** `src/api/routes.ts` — `'/v1/ai-profiles/:id'`, `'/v1/agents/:id'`

## Telegram, Discord and Slack

### Discord or Slack ended up connected to a different agent than the one the sheet named
- **Check:** the agent named in the Connect sheet has no Discord or Slack row, while another agent you had just clicked does; Activity shows the connect on that other agent.
- **Cause:** opening Connect for one agent, then for another before the first had loaded, could paint the first agent's sheet while Connect sent the tokens to the second.
- **Fix:** upgrade; on the wrong agent, remove the channel (the bot is parked) and connect the right agent using the parked bot.
- **Fixed in:** `v2.160.0`
- **Code:** `web/index.html` — `openChanSetup`, `chanOpenGen`

### Bring in from OpenClaw: "couldn't confirm OpenClaw stopped using this bot (Telegram didn't answer)"
- **Check:** the row of that agent in Add → From OpenClaw says it; `curl -sS https://api.telegram.org` from this machine fails or hangs.
- **Cause:** after OpenClaw's gateway restarts with the bot turned off, Hatchabot asks Telegram whether anything still polls the bot. When Telegram does not answer, nothing is known, and taking the bot over could leave two programs answering it. Before v2.160.0 no answer counted as "stopped".
- **Fix:** get this machine back on the network to Telegram, then bring the agent in again. The bot is already turned off in OpenClaw's config.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/openclawImport.ts` — `quiesceOpenclawBots`, `botQuiet`; `web/index.html` — `bringInSelected`

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

### Connecting Discord or Slack keeps saying "Couldn't reach the server for the setup steps — try again", until the page is reloaded
- **Check:** the first try came while the app was restarting or the connection dropped; every try after it says the same at once.
- **Cause:** the failed fetch of the setup steps was kept as "no steps", so trying again never asked the server again.
- **Fix:** upgrade: a failed fetch is not kept, and the next try asks again. On an older version, reload the page.
- **Fixed in:** `v2.160.0`
- **Code:** `web/index.html` — `openChanSetup`, `chanFields`

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

### Two agents run the same app on one mailbox, and nothing warned you
- **Check:** each agent's page → App shows the app, and both agents' app config (`config.json` under `~/.openclaw/apps/<app>/data` in the agent) names the same address.
- **Cause:** the check looked only at the values typed in. A mailbox that came from the app's default or from the agent's existing config was not checked; an update, even one that changed the mailbox, was never checked; and two installs at the same moment could each miss the other.
- **Fix:** upgrade: installs, updates and new agents from a repo are judged on the config the app would actually run with, and one install of an app per account runs at a time. Then stop the app on one of the two agents (its page → App → Stop app).
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/routes.ts` — `sharedConfigCheck`, `oneAppAtATime`; `src/orchestrator/apps.ts` — `checkConfig`

### "Run an app from a repo" shows an app password or key as you type it
- **Check:** the field is marked `"secret": true` in the app's `hatchabot.json`, and its box in the dialog shows the text.
- **Cause:** the dialog ignored `secret` and drew every field as a plain text box, filled with its default.
- **Fix:** upgrade: a secret field is a hidden box the browser does not autofill, never filled in; left blank, the app keeps the value it has (or its default).
- **Fixed in:** `v2.160.0`
- **Code:** `web/index.html` — `appRead`, `appValues`

### A new agent's page says "Its app could not be installed"
- **Check:** the message under it on the agent's page (App), and `app.install_failed` in its Setup log.
- **Cause:** the app made for it from a repo failed to install once the agent was running: its tests failed, a value it needs was missing, or the repo could not be read.
- **Fix:** fix the cause (the message says which), then press **Try again** on the agent's page; or install it by hand with `hatchabot app install <agent> <dir|url>`.
- **Fixed in:** —
- **Code:** `src/api/routes.ts` — `runPendingApp`; `web/index.html` — `v2LoadApp`

### A new agent's waiting app still has its app password in plain text in the database
- **Check:** the agent's app has not gone in yet (its page shows it waiting, or "Its app could not be installed"), it was set up before v2.160.0, and `sqlite3 <db> "SELECT vals FROM agent_app_pending"` shows the value of a field the app's `hatchabot.json` marks `"secret": true`. After an upgrade, the service log names such agents under "waiting app installs whose manifest could not be read".
- **Cause:** before v2.160.0 a waiting install kept all its values in its row, secrets included, until it went in or the agent went. v2.160.0 kept new ones in the secret store but left the rows already written.
- **Fix:** upgrade. At start, before serving, the service moves those values to the secret store and leaves references, reading the app's manifest from its folder or the local mirror of its repo address (never fetched). A row whose manifest can't be read there (the folder moved, the mirror gone) is left as it is and tried again at the next start: put the folder back, press **Try again** on the agent's page, or archive or delete the agent.
- **Fixed in:** `v2.162.0`
- **Code:** `src/orchestrator/appPending.ts` — `stashOldPendingSecrets`; `src/orchestrator/apps.ts` — `manifestAt`, `mirrorDir`

### `hatchabot app install` says "Needs a value for: …"
- **Check:** `hatchabot app inspect <dir|url>` lists what the app asks for.
- **Cause:** a required setting in the app's manifest has no value yet (and none in its existing config).
- **Fix:** pass it as `key=value` after the source, e.g. `hatchabot app install <agent> ~/myapp mailbox=<its address>`.
- **Fixed in:** —
- **Code:** `src/orchestrator/apps.ts` — `mergeConfig`

### An app's scheduled task failed with missing files while its settings were being changed
- **Check:** an Update that gave new values on the commit already running (the App row's commit did not change), and the app's task failed at that moment with a file or module missing under `~/.openclaw/apps/<app>/releases/<commit>`.
- **Cause:** before v2.160.0 an install unpacked the release folder afresh even when it was the live one: the running code, and anything its tests had built in that folder, was deleted and replaced before the new values had even been tested.
- **Fix:** upgrade: the same commit keeps its live folder, and only the new configuration is staged and tested. The next run of the task works once the update has finished.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/apps.ts` — `installRelease`

### An app update reset the app's settings (mode, filters) to its defaults
- **Check:** after an Update, `data/config.json` under `~/.openclaw/apps/<app>` in the agent has the manifest's defaults where you had set your own values, and nothing you typed asked for that.
- **Cause:** before v2.160.0 a config file that could not be read (permissions, a disk error) was taken for no config at all, so the update wrote the defaults over it.
- **Fix:** upgrade: a config that cannot be read stops the update ("Could not read … in the agent"), with nothing changed. Fix the file's permissions in the agent's console, then Update again. On an older version, set the values again (`hatchabot app update <agent> key=value …`).
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/apps.ts` — `installRelease`

### After a failed app update the app runs no release at all
- **Check:** the update failed, and `~/.openclaw/apps/<app>/current` in the agent is gone (`readlink` prints nothing), while the App row still shows a commit.
- **Cause:** before v2.160.0 a `current` link that could not be read was taken for "nothing installed yet", so a later failure in the same update "put back" no release by removing the link.
- **Fix:** upgrade: a link that cannot be read stops the update before anything changes ("Could not tell which release of … is live"). To recover on an older version, run Update again, or Roll back.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/apps.ts` — `currentLink`

### Reading an app's repo says "two tasks are named …" or "two fields have the key …"
- **Check:** the app's `hatchabot.json` lists one name twice under `tasks`, or one key twice under `config.fields`. Before v2.160.0 the same manifest was accepted: `openclaw cron list --all` in the agent showed `<app>-<task>` twice (it ran twice), or a value you typed was replaced by a later field of the same key.
- **Cause:** the manifest check did not require task names and config keys to be unique.
- **Fix:** give each task its own name and each field its own key in `hatchabot.json`, commit, and install or Update again (the update takes off the doubled task).
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/apps.ts` — `manifestSchema`

### An app setting cannot be cleared: an empty value keeps the old one
- **Check:** `hatchabot app update <agent> filter=` (or an empty box in the dialog) and the app's `data/config.json` still has the old value.
- **Cause:** before v2.160.0 an empty value was treated as "not given", and a value not given keeps what the file has.
- **Fix:** upgrade: an empty value clears an optional field (`""`, `[]` for a list, `null` for a number or switch); a value left out is still kept. A required field cannot be cleared.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/apps.ts` — `mergeConfig`

### An app's number setting is `null` in its config, or an install says "Not a valid value: … must be a number"
- **Check:** the value typed for a `"type": "number"` (or `bool`, `list`, `email`) field in `hatchabot.json` does not fit it, e.g. `max_per_day=abc`.
- **Cause:** before v2.160.0 values were converted without a check, so `abc` became NaN and was written as `null` (and `maybe` for a switch as `false`).
- **Fix:** upgrade: a value that does not fit its type is refused with what was expected. Give it again as a number, `true`/`false`, a comma list or an email address.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/apps.ts` — `mergeConfig`, `coerce`

### Installing an app says "Hatchabot has nothing to fill … with"
- **Check:** the field it names is `"required": true` with `"from"` in `hatchabot.json` (e.g. `owner.telegram`), and the reason in brackets: the owner has not linked Telegram, the agent has no Telegram bot, or the account has no email address. Before v2.160.0 the install went ahead and wrote an empty value (an app sending notices then had no recipient).
- **Cause:** a field the app needs is filled from something Hatchabot does not have for this agent or its owner.
- **Fix:** set it up (Settings → You for Telegram; give the agent a bot), then install again or press Try again on the agent's page.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/apps.ts` — `mergeConfig`, `installRelease`

### An app task you had turned off stays after Stop app, or runs twice after an Update
- **Check:** `openclaw cron list --all` in the agent's console shows an `<app>-<task>` job that is disabled (left after Stop app), or one disabled beside an enabled one of the same name after an Update.
- **Cause:** before v2.160.0 Hatchabot listed the app's tasks without `--all`, so a disabled one was invisible to Update, Roll back and Stop app.
- **Fix:** upgrade, then Update (or Stop app) again: disabled tasks are listed too and replaced or taken off. On an older version, remove the leftover with `openclaw cron rm <id>`.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/apps.ts` — `appJobs`

### Every app install, update or Stop app says "The agent's scheduled task list is incomplete or malformed"
- **Check:** `openclaw cron list --all --json` in the agent's console has a job with no `name` (one of the agent's own, not the app's), and the message comes back on every try.
- **Cause:** before v2.160.0 every job of the agent had to have an id and a name, even ones that have nothing to do with the app.
- **Fix:** upgrade: only the app's own jobs (`<app>-…`) are checked. On an older version, give the unnamed job a name or remove it.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/apps.ts` — `appJobs`

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

### A removed member can still message the agent, and Access says it still lets them in
- **Check:** Sharing → Access (or Verify now) still lists the removed person's chat id; `openclaw.json` on the agent has it under `channels.<app>.allowFrom`, `channels.<app>.groupAllowFrom` or the bot account's `groupAllowFrom`.
- **Cause:** removing a member took their id out of the bot account's `allowFrom` and the approval store only. OpenClaw also admits ids listed for the whole app and an account's group list, which a hand edit or an imported setup may have put there.
- **Fix:** upgrade, then remove them again: their id is taken out of those lists too (only theirs; the other entries stay).
- **Fixed in:** `v2.162.0`
- **Code:** `src/orchestrator/members.ts` — `allowlistScrubScript`, `revokeMember`

### A pool bot serving an agent is renamed "Hatchabot (unassigned)"
- **Check:** in Settings → Telegram, the bot is leased but its pending name is "Hatchabot (unassigned)".
- **Cause:** the release parked the idle name after another agent had already leased the bot.
- **Fix:** upgrade, then Sync name on the agent.
- **Fixed in:** `v2.153.0`
- **Code:** `src/channels/telegramPool.ts` — `release`

### After unlinking your Telegram, new agents still admit it
- **Check:** Settings → You says "Not linked", yet a new agent's owner seat is bound to the old Telegram id from its first build, or its scheduled tasks message that id.
- **Cause:** unlinking cleared only the account's link. The fallback that infers your Telegram from your existing agents' owner seats found the same id again and seeded it into every new agent.
- **Fix:** upgrade, then unlink again. The ids an unlink lets go are now remembered and never inferred back; linking one again ("That's me") lifts that. Existing agents keep admitting it until you remove it from their members.
- **Fixed in:** `v2.160.0`
- **Code:** `src/store/store.ts` — `knownChannelUserId`, `setAccountTelegram`, `telegram_unlinks`

### Someone removed just as they first messaged the bot can still chat with it
- **Check:** they are not in the agent's members, yet the bot answers them; the trail shows their removal at the moment their invite's window let them in.
- **Cause:** the window approved their message with OpenClaw before binding it to their seat. A removal that landed in between left the approval with no member row to remove them by.
- **Fix:** upgrade. An approval that cannot be bound is now taken back and the window closes. On an older version, invite them again and remove them once they are in.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/claim.ts` — `claimFirstContact`, `scrubApproval`

### `hatchabot bots` lists a sleeping agent's bot as reclaimable
- **Check:** the bot's agent shows `[STOPPED]` in the list and is asleep (its tile says so; `HATCHABOT_HIBERNATE_AFTER` is set).
- **Cause:** every stopped agent's bot was counted as a slot doing nothing, though a sleeping agent is woken by a message on that bot.
- **Fix:** upgrade: a sleeping agent's bot is listed as in use, marked `[asleep]`. Don't delete it in @BotFather: the agent would never wake on a message again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/bots.ts` — `auditBots`

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

### An archive cut off by a restart is held: "its runtime could not be confirmed stopped"
- **Check:** Alerts shows a held "Archive" with this outcome; the trail has `archive.not_stopped`; the agent's runner is asleep, or `docker ps` there still lists its container.
- **Cause:** Hatchabot restarted after the agent's bot was given back but before the archive finished, and the agent's runtime could not be confirmed stopped afterwards. Before v2.160.0 the failed stop was ignored: the agent was marked archived while its container might still poll a bot that another agent could lease.
- **Fix:** wake the machine or bring Docker back, then choose **Try again** (`hatchabot ops recover <op-id> retry`). It stops the agent, checks it is down and finishes the archive. On an older version, run `docker stop` on the archived agent's container.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/archive.ts` — `resumeArchive`; `src/orchestrator/quiesce.ts` — `stopAndConfirm`

### Agent-to-agent consults always fail with an unauthorized caller
- **Check:** the agent has peers, yet `/message` calls from it are refused; the stored `agent-call-token/<id>` secret does not match the live hash.
- **Cause:** the token's hash was saved before its secret; a failed write or two grants at once left them different, and nothing repaired it.
- **Fix:** upgrade, change the agent's peers once (that mints a fresh token), then rebuild it.
- **Fixed in:** `v2.153.0`
- **Code:** `src/api/routes.ts` — `ensureAgentCallToken`

### An agent you disconnected from a peer still got a consult answered
- **Check:** the peer's timeline shows `a2a.consult` from that agent after you removed it from the peer's list; the peer was asleep when the consult came in.
- **Cause:** the consult's permission was checked before waking the sleeping peer, and not again once it was awake; a change made during the wake did not stop it.
- **Fix:** upgrade; the caller's permission and call token are checked again once the peer is awake.
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/message'`, `ensureAwake`

### "Connect to each other" failed once, and after trying again the agents still cannot consult ("Agent call token required")
- **Check:** the agents list each other as peers, but a consult is refused with HTTP 401 "Agent call token required", and the first Connect returned an error.
- **Cause:** the connect saved the grants first and then made each agent's call token. When making a token failed, a second Connect found the grants already in place and skipped the token.
- **Fix:** upgrade, press Connect to each other again, then rebuild the agents it names. Connect now makes any missing token even when nothing else changes.
- **Fixed in:** `v2.160.0` (#167)
- **Code:** `src/api/routes.ts` — `'/v1/agent-peers/mesh'`, `ensureAgentCallToken`

### A script's peers update removed every peer an agent could consult
- **Check:** the agent's peers emptied right after a `PUT /v1/agents/<id>/peers` whose body had no `peerIds`, or not a list there.
- **Cause:** anything but a list was read as an empty list, which revokes every grant.
- **Fix:** upgrade: such a body is refused (HTTP 400) and changes nothing; send `{"peerIds": []}` to remove all. Grant the lost peers again (the agent's Sharing → Other agents it can ask).
- **Fixed in:** `v2.160.0` (#166)
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/peers'`

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

### Clone failed, and cloning again says the name is taken
- **Check:** the first Clone answered with an error, and the agents list shows an agent with the clone's name that never built (Provisioning or failed), with no runtime.
- **Cause:** the clone was made first and its settings (environment variables) copied after; when a copy failed, the half-made clone and the secrets copied so far were left behind.
- **Fix:** upgrade: a failed clone is undone completely and says "Nothing was kept". Until then, delete the half-made clone, then clone again.
- **Fixed in:** `v2.160.0` (#165)
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/clone'`

### A git data source added again still holds the old repo, or a writable one cannot push ("PUSH-DISABLED-read-only-public-clone")
- **Check:** in the agent, `git -C ~/.openclaw/<mount> remote -v` shows another repo than the source's card, or a push URL of `PUSH-DISABLED-read-only-public-clone` for a source added with a deploy key.
- **Cause:** removing a git source keeps its clone on the volume. A source added again at the same mount found that clone and skipped cloning, keeping its old address and, from a public source, its disabled push URL.
- **Fix:** upgrade and rebuild the agent. A clone of the same repo is repointed (and can push again with a deploy key); a clone of another repo is moved aside to `<mount>.replaced-<time>` (its files are kept) and the new repo cloned.
- **Fixed in:** `v2.160.0` (#88, #89)
- **Code:** `src/orchestrator/gitSource.ts` — `retainedCloneCheck`, `buildGitSyncScript`, `buildPublicGitSyncScript`

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

### A removed AI source or machine, or an answered pairing knock, shows again for a few seconds
- **Check:** right after removing an AI source or machine, or approving someone who knocked in a chat app, the old entry (or "🔑 Knocking") comes back and goes away again by itself.
- **Cause:** the guard against overlapping refreshes covered the agent list only: an older refresh's sources, machines or knocks that arrived after a newer one's replaced them.
- **Fix:** upgrade. Otherwise it corrects itself on the next refresh.
- **Fixed in:** `v2.162.0`
- **Code:** `web/index.html` — `refreshNow`, `metaSeq`, `pairSeq`

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
- **Fix:** **Finish**, or **Revert to the copy taken before**, running or stopped. Before v2.160.0 a stopped agent answered "Start the agent first", while Start was refused until the choice was made; upgrade, then choose again (its files are written on its volume).
- **Fixed in:** `v2.155.0`; a stopped agent: `v2.160.0`
- **Code:** `src/orchestrator/snapshots.ts` — `resumeSnapshotRestore`, `recoverSnapshotRestore`

### An app's page waits for a choice: "The … change to … was interrupted by a restart part-way through the switch"
- **Check:** a held `app-install`, `app-update` or `app-rollback` operation; the agent's `apps/<app>/current` differs from the app record.
- **Cause:** a restart during or after the switch, before Hatchabot recorded it.
- **Fix:** **Use the new release** or **Go back to the previous one**; either leaves the release, its config, its scheduled tasks and the record in agreement.
- **Fixed in:** `v2.155.0`
- **Code:** `src/orchestrator/appOperations.ts` — `resumeAppOperation`, `recoverAppOperation`

### An app update cut off by a restart says it finished, but the app still runs with its old values
- **Check:** an Update that gave new values on the commit already running, a restart while it ran, and the operation then marked done; `data/config.json` under `~/.openclaw/apps/<app>` in the agent has the old values (or `openclaw cron list --all` shows one of its tasks twice).
- **Cause:** before v2.160.0 the restart compared only the record and the `current` link with the new commit. A change of values keeps the same commit, so they matched from the start, and the operation was called done while the new config was still staged, which was then deleted.
- **Fix:** upgrade: the staged config and the app's tasks are checked too. A change cut off before the switch is undone ("nothing changed"; run Update again), and one cut off after it waits for **Use the new release** or **Go back to the previous one**. On an older version, run Update again with the new values.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/appOperations.ts` — `resumeAppOperation`, `tasksAre`

### A failed app update said "the running version is unchanged", but the agent runs the new release
- **Check:** the update's message on the agent's page ends "Putting … back failed too", or says its scheduled tasks "could not be confirmed"; `readlink ~/.openclaw/apps/<app>/current` in the agent names the new commit, or the config has the new values, while the App row shows the old one.
- **Cause:** before v2.160.0 the page said "unchanged" after any failed update, and when putting the old release back failed too, the staging folder holding the config it replaced was deleted all the same and the operation marked failed.
- **Fix:** upgrade: the page says "unchanged" only when the server confirms it; when the put-back fails, the staging folder is kept and the operation waits on the agent's page for **Use the new release** or **Go back to the previous one**. On an older version, run Update again (or Roll back); if the old config is gone, set its values again with `hatchabot app update <agent> key=value …`.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/apps.ts` — `installRelease`, `outcome`; `src/api/routes.ts` — `appOpFailed`, `appFail`; `web/index.html` — `v2AppUpdate`

### An app update said "its tests passed", but the app has no tests
- **Check:** the app's `hatchabot.json` has no `test`, and the update's message said "— its tests passed".
- **Cause:** before v2.160.0 the page said so after every successful update, whatever the server answered (`test: null` when there are none).
- **Fix:** upgrade: it says "(it has no tests to run)" instead. Add a `test` command to the manifest to have each release checked before it goes live.
- **Fixed in:** `v2.160.0`
- **Code:** `web/index.html` — `v2AppUpdate`

### "Run an app from a repo" installed the repo read before, not the one whose read failed
- **Check:** in the dialog you read one repo, then another whose read failed (an error under the box), then pressed Install, and the first repo went in.
- **Cause:** before v2.160.0 a failed read left the earlier one's form and its Install button in place.
- **Fix:** upgrade: each read forgets the one before, and Install stays off until a read succeeds. If the wrong app went in, Stop app on the agent's page and install the right one.
- **Fixed in:** `v2.160.0`
- **Code:** `web/index.html` — `appRead`

### Alerts listed general alerts above failed agents, and people knocking near the bottom
- **Check:** View by → Alerts; the order of its sections.
- **Cause:** the view sorted its sections by label, so the emoji decided the order.
- **Fix:** upgrade; the sections sort most urgent first, with "Waiting for your choice" at the top.
- **Fixed in:** `v2.156.0`
- **Code:** `web/index.html` — `v2ViewKey`

### Alerts says "It can still reach what it should not: <account>: still there"
- **Check:** open the agent → Sharing → Access → Verify now; the ⚠ line names the account, bot, folder, variable or person, and when it was found.
- **Cause:** the last look inside the running agent found something Hatchabot no longer gives it — a Google account detached while the removal failed, a bot it was moved off still in its OpenClaw settings, a variable or folder removed but the agent not rebuilt yet.
- **Fix:** rebuild the agent (it writes its settings again and takes detached accounts off), then Verify now. For a Google account, detach it again while the agent runs.
- **Fixed in:** `v2.157.0`
- **Code:** `src/orchestrator/accessOverview.ts` — `verifyAgentAccess`

### Access shows "removal pending over a day" for a Google account
- **Check:** Sharing → Access shows the account with ⚠ and "removal pending since …"; is the agent stopped, asleep, or on a runner that is off?
- **Cause:** a removal runs only inside a running agent: it waits for the next start, wake or rebuild — or gog's remove kept failing.
- **Fix:** start or wake the agent (the removal runs then), then Verify now; if it stays, rebuild it.
- **Fixed in:** `v2.157.0`
- **Code:** `src/orchestrator/googleConnections.ts` — `syncConnections`

### Access shows "a different token is running" on the Telegram bot
- **Check:** Sharing → Access → Verify now; the Telegram line has ⚠ "a different token is running".
- **Cause:** the bot token in the agent's `openclaw.json` is not the one Hatchabot holds for its channel (a hand edit, or a restore from an older backup).
- **Fix:** rebuild the agent: Hatchabot writes its bot settings again.
- **Fixed in:** `v2.157.0`
- **Code:** `src/orchestrator/accessOverview.ts` — `accessProbeScript`

### After a failed move to another Hatchabot, the agent runs on both servers (two copies answer the same bot)
- **Check:** the source's move said "The transfer to … failed (it answered 504 …). Your agent is unchanged.", yet the other server shows the agent RUNNING; the source runs a version older than v2.158.1.
- **Cause:** the source read the destination's empty agent list as "the import rolled back" — but the import makes its agent row only after looking at the image, so it was still on its way to RUNNING.
- **Fix:** upgrade both servers; stop one copy now (keep the one on the server you moved to).
- **Fixed in:** `v2.158.1`
- **Code:** `src/orchestrator/migrate.ts` — `destinationHasAgent`, `receiveMove`, `moveState`

### Importing a downloaded copy says "This copy was saved by OpenClaw 2026.7…; this machine would run it on 2026.9…, which cannot read it"
- **Check:** the copy's OpenClaw version is older than 2026.8 and this machine's image is 2026.8 or newer (the message names both).
- **Cause:** the import's version check was inverted: it refused the normal upgrade and let a newer copy onto an older image.
- **Fix:** upgrade Hatchabot and import again.
- **Fixed in:** `v2.158.1`
- **Code:** `src/orchestrator/transfer.ts` — `importAgentInner`

### Importing an agent's own download says "That export is malformed or from an incompatible version (ai.model)" or "(envVars)"
- **Check:** the agent's AI source names a model id longer than 64 characters (Settings → AI), or the agent has more than 64 environment variables (its Environment tab).
- **Cause:** the source machine accepted both, but the import read model ids up to 64 characters and at most 64 variables, so a valid agent's own copy was refused.
- **Fix:** upgrade the machine you import on; the same file then imports. The AI source's model is only a hint there, and an import takes up to 256 variables. From v2.160.0 an agent can have at most 64 variables set (an older one with more keeps them).
- **Fixed in:** `v2.160.0` (#162, #141)
- **Code:** `src/orchestrator/transfer.ts` — `ManifestSchema`; `src/orchestrator/envPolicy.ts` — `MAX_AGENT_ENV_VARS`, `MAX_IMPORTED_ENV_VARS`

### An agent fails to build after an environment variable was saved ("must be a string without null bytes")
- **Check:** the build error says an argument "must be a string without null bytes" (ERR_INVALID_ARG_VALUE); a variable's value was pasted from a file or a program.
- **Cause:** the value held a NUL character, which a program's environment cannot carry. The setting stored it; the next build could not hand it to Docker.
- **Fix:** upgrade: such a value is refused when it is set, and an archive carrying one is refused on import with the variable's name. Remove that variable (Environment tab) and set it again without the NUL, then rebuild.
- **Fixed in:** `v2.160.0` (#142)
- **Code:** `src/orchestrator/envPolicy.ts` — `envValueProblem`; `src/api/routes.ts` — `'/v1/agents/:id/env'`

### An app's scheduled tasks are missing after an interrupted app install ("Put its scheduled tasks back")
- **Check:** the agent's app operation waits for you with this choice and names the missing jobs; `openclaw cron list` in the agent's console has no `<app>-…` jobs for the app on record.
- **Cause:** installing an app over another takes the old app's tasks off first; a restart before the switch puts them back, and re-adding them failed (the gateway refused the job, or the list could not be read). Before v2.158.1 this was reported as "nothing changed".
- **Fix:** once the agent's gateway is healthy, choose **Put its scheduled tasks back**; it stays held until every task is confirmed present.
- **Fixed in:** `v2.158.1`
- **Code:** `src/orchestrator/appOperations.ts` — `resumeAppOperation`, `putTasksBack`, `tasksBackAgain`

### An agent still holds a Google account after its connection was deleted
- **Check:** the agent's Sharing → Access (or `gog auth list --json` in the agent) still lists the deleted connection's email, but the connection is gone from Connections and the agent has no pending removal for it; usually the agent was rebuilt, started or woken around the delete, and the same Google account is connected under another person's account (so the grant was not revoked).
- **Cause:** the delete took the account off each agent but left the agent attached until the end; a sync in that gap imported it again after its removal record was cleared.
- **Fix:** upgrade; then remove the account inside the agent (`gog auth remove --force -- <email>`) or attach and delete again.
- **Fixed in:** `v2.158.1`
- **Code:** `src/orchestrator/googleConnections.ts` — `materializeConnection`

### Every Google account stopped working after a new OAuth client was saved
- **Check:** ⚙ Settings → Connections marks accounts "made with an earlier OAuth client"; the agents' Google tools fail to refresh their token; the trail shows `google.client_replaced`. Before v2.160.0 nothing was marked: the client had been removed and a different one saved, or saved over the old one.
- **Cause:** a refresh token works only with the OAuth client that issued it. Saving a client with a different client ID paired every stored token with the new client.
- **Fix:** put the original client back if you still have it, or press Connect and pick each marked account again (each person, from their own login). From v2.160.0 saving a different client ID asks first, naming how many accounts will need connecting again; a new secret for the same client ID does not.
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/routes.ts` — `/v1/google-oauth/client`, `countConnectionsFromOtherClient`; `src/orchestrator/googleConnections.ts` — `materializeConnection`

### Removing the Google OAuth client said it was gone, but Connections still shows it configured
- **Check:** after Remove, ⚙ Settings → Connections still shows the client; from v2.160.0 Remove says "could not be removed from the secret store".
- **Cause:** a failed delete in the secret store was swallowed and the answer said the client was removed.
- **Fix:** upgrade and press Remove again; if it keeps failing, the server log names the secret-store error (`google.client_remove_failed`).
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/routes.ts` — `/v1/google-oauth/client`

### A Google account came back after Disconnect in the agent's Connections
- **Check:** the account was attached under ⚙ Settings → Connections and disconnected from the agent's own Connections list; after its next start, wake or rebuild `gog auth list --json` in the agent names it again, and the account still shows attached to the agent under ⚙ Settings → Connections.
- **Cause:** that Disconnect only removed the account from gog inside the agent and left the attachment, so the next sync imported it again. The page detached it first, but fell back to the plain remove when it could not read the connection list.
- **Fix:** upgrade, then Detach it (or Disconnect again). From v2.160.0 the server detaches an attached account and records the removal, whatever the page sends.
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/routes.ts` — `/v1/agents/:id/connections/:email`; `web/index.html` — `disconnectAccount`

### A failed Google removal was cleared although the account was still in the agent
- **Check:** the trail shows `connection.remove_failed` and then `connection.removed_from_agent` with `alreadyGone`, yet `gog auth list --json` in the agent still names the account.
- **Cause:** when the remove failed, an account list without an `accounts` array (for example `{}`) was read as "holds nothing", which confirmed the removal and cleared its retry.
- **Fix:** upgrade, then detach the account again (or rebuild the agent). From v2.160.0 only a real list confirms a removal; anything else keeps the retry.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/googleConnections.ts` — `gogAccounts`, `dematerializeConnection`

### A Google account shows Drive (or Calendar, …) as connected, but the agent gets permission errors there
- **Check:** in the agent, `gog auth list --json` lists the account with the service, yet every call to it fails with "insufficient permission" / 403; at Google, myaccount.google.com → Security → Third-party connections shows the Hatchabot app without that access.
- **Cause:** Google's consent screen lets you untick a service. The connection recorded every service asked for, not the ones Google granted.
- **Fix:** upgrade, then press Connect for the account again and leave the service ticked. The connection now lists only what was granted, and the page after consent names any service that was not.
- **Fixed in:** `v2.160.0` (#174)
- **Code:** `src/orchestrator/googleConnections.ts` — `grantedServices`, `exchangeGoogleCode`, `isGoogleService`

### A removed repo source still pulls or pushes
- **Check:** after removing a repo source, the agent still has `~/.openclaw/.ssh/<repo>_deploy`, or the trail shows `datasource.key_left`.
- **Cause:** the source's record was deleted first; if taking the key off the volume (or out of the secret store) then failed, nothing retried it.
- **Fix:** upgrade; the removal is recorded and retried at the agent's next start, wake or rebuild until the key is gone. Also delete the deploy key on the repo's host (its settings → Deploy keys): a copy outside Hatchabot stays trusted until then.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/provision.ts` — `scrubRemovedDataSources`; `src/api/routes.ts` — `/v1/agents/:id/data-sources/:dsId`

### Deleting an agent fails: "Couldn't remove all of the agent's stored keys"
- **Check:** the agent shows FAILED with "Delete could not remove all of its stored keys — tap Delete again"; the server log says `secret delete failed during delete`.
- **Cause:** the secret store refused a delete (often a busy or locked database). Before v2.160.0 the failure was ignored, the agent was marked deleted, and its env values, deploy keys or call token stayed stored with nothing naming them.
- **Fix:** press Delete again. Keys an older version left behind are deleted at the next start of Hatchabot (`deleted orphaned agent secrets` in the log).
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/routes.ts` — `/v1/agents/:id`; `src/store/store.ts` — `sweepOrphanAgentSecrets`

### An app from a repo reads a different mailbox than the Google account it was given
- **Check:** the app's mailbox setting names one address, while the agent's Connections shows a different Google account attached.
- **Cause:** in "run an app from a repo", the mailbox field followed only the first account picked; picking another one after it left the first address.
- **Fix:** upgrade and change the app's mailbox setting (or reinstall it) so it names the attached account. From v2.160.0 every pick fills the field, and an install whose field and account differ is stopped.
- **Fixed in:** `v2.160.0`
- **Code:** `web/index.html` — `appConnPicked`, `appConnMismatch`

### A removed member's "still lets them in" warning disappeared after Verify now, or Verify now says "people on telegram (pairing store: …)" was skipped
- **Check:** Sharing → Access → Verify now; from v2.158.1 the skipped list names the unread source, e.g. `pairing store: EACCES`, `pairing store: ERR_SQLITE_ERROR`, `allowFrom file: not valid JSON`.
- **Cause:** a source OpenClaw uses to admit chat users (`~/.openclaw/openclaw.json`, `credentials/*-allowFrom.json`, `state/openclaw.sqlite`) could not be read inside the agent — permissions, a node without `node:sqlite`, a schema change. Older releases took that to mean nobody was admitted.
- **Fix:** upgrade so the warning is kept; then fix the named source (file permissions, or rebuild the agent on a current image) and Verify again — the person is shown as gone only after a complete read.
- **Fixed in:** `v2.158.1`
- **Code:** `src/orchestrator/accessOverview.ts` — `accessProbeScript`, `verifyAgentAccess`

### Access says nobody else is admitted, but someone not in the members can still message the agent
- **Check:** in the agent's `~/.openclaw/openclaw.json`, `channels.<app>.allowFrom` or `channels.<app>.groupAllowFrom` (not under `accounts`), or an account's `groupAllowFrom`, lists their id.
- **Cause:** the access check read only each bot account's `allowFrom`; a list set for the whole chat app, or for its groups, admits people too and was missed.
- **Fix:** upgrade and Verify now: those lists are read, and a person they admit who is not a member shows as ⚠. Take the id out of that list (Hatchabot does not write it), then Verify again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/accessOverview.ts` — `accessProbeScript`

### A derived image is refused: "The last line ends with a \ that continues it into nothing", or "The heredoc <<EOF is never closed"
- **Check:** the image's Dockerfile lines (Settings → Images): the last instruction ends with `\`, or a `<<WORD` heredoc has no line `WORD` after it. A derived image built before v2.160.0 from such lines runs as root: `docker inspect <its tag> --format '{{.Config.User}}'` prints `root` instead of `node`.
- **Cause:** Hatchabot appends `USER node` after your lines. A trailing `\` joins it to your last instruction, and an open heredoc takes it in as text, so the image stayed root. Saving and rebuilding such lines is now refused.
- **Fix:** finish the last instruction (drop the trailing `\`) or close the heredoc, then save and rebuild the image; agents on an old root image get `node` on their next rebuild.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/derivedImage.ts` — `dockerfileProblem`, `buildDerivedImage`

### An agent's Health shows a new "core/doctor/security" finding after an upgrade
- **Check:** the agent's Health → Config lint lists a `core/doctor/security` finding that mentions `gateway.auth.token` or `botToken`; `openclaw doctor --lint --json` in the agent's console shows it with its severity.
- **Cause:** before v2.160.0, Config lint hid every security finding that merely mentioned a token or "plaintext", whatever it said and however severe — only OpenClaw's by-design warning about tokens kept in openclaw.json was meant to be hidden (it is still counted as "known").
- **Fix:** read the finding and act on it: it is a real one (a token readable by others, sent over plain HTTP, and so on). Errors are never hidden.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/health.ts` — `MUTED`, `isMuted`, `doctorLint`

### An agent lost its conversations or its login after a file was uploaded into its folder
- **Check:** in Files, `.openclaw/agents/<agent>/agent` shows `openclaw-agent.sqlite` (or its `-wal`, `-shm`, `-journal`), `auth-profiles.json` or `auth-state.json` changed at the time someone uploaded a file of that name, just before the trouble began.
- **Cause:** uploads into the agent's own folder were allowed, and that folder also holds OpenClaw's live session database and its logins, so an upload under one of those names replaced them.
- **Fix:** upgrade: an upload under those names is refused there, even through a link that leads there. An agent already hit: restore its conversations from a backup (Backups → Restore), and sign its AI source in again if it says it needs a login.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/agentFiles.ts` — `RUNTIME_STATE_FILES`, `uploadAllowed`, `putArgv`

### After a restart, an agent shows "Setup was interrupted — tap Retry" although its container is running
- **Check:** `docker ps` lists its container, but the agent does not answer and `hatchabot doctor` (or its page's Checks) says its gateway is not responding; the event log has `reconcile.interrupted` with `unhealthy: true`.
- **Cause:** Hatchabot restarted during the agent's setup or rebuild, after its container started but before its gateway answered. Before v2.160.0 such an agent was marked running, with the rest of its setup never done.
- **Fix:** tap **Retry** (or Rebuild): it reuses the agent's volume and runs the setup again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/reconcile.ts` — `applyReconcileRule`

### An agent was rebuilt on its own in the middle of a reply
- **Check:** the event log has `rebuild.auto` for the agent while it was answering; its runner was slow or restarting around then (a session read failed).
- **Cause:** the automatic rebuild sweep took a failed read of the agent's conversations as "no recent activity", so an agent it could not read counted as idle.
- **Fix:** upgrade. Since v2.160.0 an unattended rebuild needs its conversations read and quiet for 10 minutes; one that cannot be read waits for a later sweep. `HATCHABOT_REBUILD_POLICY=manual` turns automatic rebuilds off.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/rebuildPolicy.ts` — `pickAutoRebuilds`; `src/api/routes.ts` — `activityEvidence`

### After a move or import, an agent pinned to a custom image is missing a tool (a compiler, a package, a messaging plugin)
- **Check:** in the agent's console, the tool is absent (`which g++`, `dpkg -l <package>`) on the destination, while `docker image inspect <its image>` on the source machine lists it in `org.hatchabot.extra-packages`, or its base image does.
- **Cause:** the image was rebuilt on the destination from its recipe, which dropped package names ending in `+` (g++), took a derived image's base as stock (its base's packages and plugins were not carried), and for packages built under a plain version tag only pulled the stock image.
- **Fix:** upgrade, then rebuild the image on the destination (remove its tag there and move or rebuild the agent again), or install the tool in a derived image. Since v2.160.0 the recipe keeps every package, lays a derived image's base packages back on, refuses a destination base without its plugins, and builds the packages onto a pulled plain base.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/imageRecipe.ts` — `recipeFor`, `buildRecipeOn`

### The runtime's tool list still shows the old image after a rebuild or a promote
- **Check:** `GET /v1/runtime/capabilities` (the Runtime list of tools) disagrees with `docker run --rm --entrypoint bash <image> -c '<tool> --version'` for the same tag.
- **Cause:** the probe was cached by the tag's name for the life of the service, and a rebuilt or promoted tag names another image.
- **Fix:** restart the service, or upgrade: since v2.160.0 the cache is keyed by the image id, so a tag that moved is probed again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/runtimeCaps.ts` — `probeImageCapabilities`

### An agent shows "healthy" but does not answer
- **Check:** in its console, `openclaw health --json` prints `{}` (or a bare `{"ts":…}`) with no `ok`, `eventLoop` or `channels`.
- **Cause:** a health answer with no report in it was counted as healthy, because nothing in it said otherwise.
- **Fix:** upgrade, then rebuild the agent if it still shows degraded. Since v2.160.0 healthy needs the gateway's own verdict or a report on its event loop or channels; an empty answer shows degraded, and one that is not an object shows unreachable.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/health.ts` — `agentHealth`

### An agent in a class will not start after a rebuild: its data was migrated for a newer OpenClaw than the class's image
- **Check:** the agent's rebuild fails on a 2026.7 image although it ran 2026.8 or newer before; its Overview shows a class with an image, and `docker inspect` of its old container names the newer image.
- **Cause:** assigning a class, or changing a class's image, pinned members without the check a direct image pin makes: 2026.7 cannot read a volume already migrated to 2026.8+. Clearing a class image also unpinned members before the rest of the edit was checked, so a member the edit then skipped lost its pin anyway.
- **Fix:** upgrade; pin the agent back to the image it ran (Overview → Runtime), or restore the copy downloaded before the move. Since v2.160.0 the class is refused for that agent ("cannot read it"), and a skipped member keeps its pin.
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/routes.ts` — `imagePinCheck`, `applyClassToAgent`

### Promote to an older default is accepted, then an archived agent cannot be restored
- **Check:** the archived agent follows the fleet default (no image pin) and ran OpenClaw 2026.8 or newer; the default now runs 2026.7.
- **Cause:** Promote checked only active followers for data the older image cannot read; an archived follower keeps its volume and is restored onto the default.
- **Fix:** upgrade, then promote the newer image back (or pin the archived agent to it) before restoring. Since v2.160.0 Promote names archived followers too.
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/routes.ts` — `/v1/runtime/images/promote`

### A class's memory cap says applied, but the container still has the old limit
- **Check:** `docker inspect -f '{{.HostConfig.Memory}}' <container>` differs from the agent's Overview memory cap, after setting, clearing or deleting a class with a memory cap (often while its runner was asleep).
- **Cause:** assigning a class swallowed a failed `docker update`, and deleting a class changed no container at all, so members kept the deleted class's cap and swap.
- **Fix:** rebuild the agent (or set its cap again). Since v2.160.0 assigning says the container kept its old limits, and deleting applies the limits that now hold and names any member it could not change.
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/routes.ts` — `/v1/agents/:id/class`, `/v1/agent-classes/:id`

### Setting a class's memory cap again after "kept its old limits" says nothing was skipped, but the container still has the old limit
- **Check:** a class edit named a member under `skipped` (its machine did not answer); the same edit again lists no one, yet `docker inspect -f '{{.HostConfig.Memory}}' <container>` still shows the old cap.
- **Cause:** the class saved the new cap before applying it, so the repeat saw no change and did not touch the containers.
- **Fix:** upgrade, then set the cap again: a class edit that names the cap or swap applies it to every member that takes it from the class. The limits check also puts it right within its next pass.
- **Fixed in:** `v2.162.0`
- **Code:** `src/api/routes.ts` — `/v1/agent-classes/:id`

### A file or folder downloaded from Files is short, or its `.tar.gz` will not open ("unexpected end of file")
- **Check:** the download is smaller than the size Files lists, and the service log shows the agent's machine or Docker failing at that time.
- **Cause:** the copy out of the agent's volume could fail part-way (the machine went to sleep, Docker stopped, a read error), and the download still ended as if it were complete.
- **Fix:** upgrade: a copy that fails now breaks off the download, so the browser reports it as failed instead of saving a short file. Download it again once the machine answers.
- **Fixed in:** `v2.160.0`
- **Code:** `src/providers/localDockerProvider.ts` — `streamFromVolume`

### An upload whose name starts or ends with a space replaced a different file
- **Check:** the file you uploaded was named with a leading or trailing space (` notes.md`), and the agent's `notes.md` now holds its content.
- **Cause:** the upload trimmed the spaces from the name, so it landed on the file without them.
- **Fix:** upgrade: the name is kept exactly as given. Restore the overwritten file from a backup if it mattered.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/agentFiles.ts` — `cleanFileName`

### Files: a folder will not open ("Invalid time value"), though the ones around it do
- **Check:** in a terminal, `docker run --rm -v <agent volume>:/v alpine ls -la --time-style=+%s /v/<folder>` shows a file with a time far in the past or future.
- **Cause:** one file's modified time was outside what the app could show, and that failed the whole folder's listing.
- **Fix:** upgrade: that file is listed with no time. To clear it, `touch` the file inside the agent.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/agentFiles.ts` — `parseListing`

### Files shows a folder's contents under another folder's name
- **Check:** you clicked through folders quickly (or the agent's machine is slow to answer); the path at the top and the files listed do not belong together.
- **Cause:** a slow read of the folder you left came back after the one you opened and was drawn over it.
- **Fix:** upgrade: only the folder opened last is drawn. Click the folder again to redraw it.
- **Fixed in:** `v2.160.0`
- **Code:** `web/index.html` — `v2LoadFiles`

### Files offers no Upload in a folder such as `.openclaw-notes`
- **Check:** the folder's name starts with `.openclaw` but is not `.openclaw` itself.
- **Cause:** the page held back uploads in every folder whose name began `.openclaw`, though only OpenClaw's own `.openclaw` folder is off limits (the server allowed it).
- **Fix:** upgrade. On an older version, upload from the folder above and move the file in from the agent.
- **Fixed in:** `v2.160.0`
- **Code:** `web/index.html` — `v2LoadFiles`; `src/orchestrator/agentFiles.ts` — `uploadAllowed`

### An upload failed, but Files only says "N of M uploaded"
- **Check:** fewer files arrived than you chose, and no reason was shown.
- **Cause:** each failed file's reason was shown for a moment, then replaced by the count when the folder was drawn again.
- **Fix:** upgrade: the count and each failed file's reason stay under the folder. Common reasons: over the size limit (`HATCHABOT_FILE_MAX_MB`), a name that is OpenClaw's live state, or the machine not answering.
- **Fixed in:** `v2.160.0`
- **Code:** `web/index.html` — `v2UploadFiles`

### Looking inside an archived agent shows "No readable files", an empty MEMORY.md, or "No conversation found on the volume"
- **Check:** the agent's machine or Docker was not answering at the time (`hatchabot doctor`; a runner asleep), or the volume is damaged; after the upgrade the same view says "Couldn't read the agent's stored files…".
- **Cause:** a read of the volume that failed was shown as an agent with no files, an empty file or no chat history.
- **Fix:** upgrade, so a failed read says so; then try again once the machine answers. Nothing is lost: the files were never read, not gone.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/inspect.ts` — `InspectReadError`, `readInspectableFile`, `listInspectableFiles`

### A large file shown when looking inside an archived agent ends in "�"
- **Check:** the file is marked "truncated — too large to show in full" and holds accented letters, other scripts or emoji.
- **Cause:** the size cut fell inside a character, and its first bytes were shown as a replacement character.
- **Fix:** upgrade: the cut now ends before that character. The file on the volume was never changed.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/inspect.ts` — `utf8Prefix`

### A command run with `--force=false` went ahead without asking
- **Check:** the command line had `--force=false` (or another on/off flag with `=value`); a destructive command such as delete or kick skipped its y/N question.
- **Cause:** the CLI read `--force` as `--yes` before looking at its value, so any `--force=…` meant "don't ask".
- **Fix:** upgrade: on/off flags with a value are now refused ("--force takes no value"). To be asked, leave the flag out.
- **Fixed in:** `v2.160.0` (#85)
- **Code:** `src/cli.ts` — `parseArgs`

### An agent was put to sleep in the middle of a conversation
- **Check:** `HATCHABOT_HIBERNATE_AFTER` is set; the timeline has `agent.hibernated` shortly after a message; the agent's container was slow or restarting then.
- **Cause:** when its conversations could not be read, the idle check took the agent's record time instead, often days old, and judged it idle.
- **Fix:** upgrade: an agent whose activity cannot be read stays up until it can be.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/hibernate.ts` — `hibernateBlocker`; `src/orchestrator/unread.ts` — `sessionsReadShell`

### A sleeping agent did not wake for a Telegram message sent just as it went to sleep, or after many messages
- **Check:** the message is waiting (the agent answers it once started); it was sent in the seconds the agent was going to sleep (`agent.hibernated` on the timeline), or a hundred or more messages were waiting.
- **Cause:** the messages waiting right after the stop were all taken as ones the agent had already handled, including one sent after the stop. And Telegram hands back a hundred waiting messages at a time, oldest first: with that many left from bedtime, newer ones were never seen.
- **Fix:** upgrade: only messages sent before bedtime count as handled, and a full hundred waiting wakes the agent. Starting it, or sending another message, wakes it on older releases.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/hibernate.ts` — `hibernateAgent`, `telegramHasMail`

### A sleeping agent no longer wakes for messages after its bot token was replaced
- **Check:** the timeline has `hibernate.token_refused` from before the new token was saved; messages wait but the agent stays asleep until restarted.
- **Cause:** once Telegram refused the old token, the wake check left that bot alone until the service restarted, even with a new token in its place.
- **Fix:** upgrade: a new token is tried again at once. On older releases restart the service or start the agent.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/hibernate.ts` — `refusedTokens`

### "Put to sleep" put an agent to sleep though it has scheduled tasks
- **Check:** the agent's tasks are on (Schedule tab); it was put to sleep by hand (Bulk actions → Put to sleep) while its tasks could not be read.
- **Cause:** an unreadable task list was taken as "no tasks", so the tasks then missed their runs while it slept.
- **Fix:** upgrade: putting it to sleep is refused with "Couldn't read its scheduled tasks just now" until the list can be read. Wake the agent so its tasks run.
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/hibernate'`

### A sleeping agent did not wake for the first message after the service restarted
- **Check:** the service restarted within seconds of `agent.hibernated` on the timeline; the first Telegram message sent after that waits unanswered until another message comes or the agent is started.
- **Cause:** a restart between the stop and the reading of what was already waiting left a placeholder mark. The next wake check took everything waiting then, including messages sent after bedtime, as already handled.
- **Fix:** upgrade: the mark is recovered by the time the agent went to sleep, so a message sent after it wakes the agent. On older releases send another message or start the agent.
- **Fixed in:** `v2.162.0`
- **Code:** `src/orchestrator/hibernate.ts` — `telegramHasMail`, `markBefore`

### An agent set to "Never sleep" was put to sleep anyway
- **Check:** `agent.hibernated` on the timeline, by the idle sweep (`quiet for … min`), seconds after its sleep setting was changed to never.
- **Cause:** the idle sweep read the setting before it read the agent's activity and tasks, and stopped it without looking again.
- **Fix:** upgrade: the setting is judged again just before the stop. Start the agent; it stays up.
- **Fixed in:** `v2.162.0`
- **Code:** `src/orchestrator/hibernate.ts` — `hibernateAgent`, `settledBlocker`

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

### Download history or Recover context finds nothing, or only old conversations, on OpenClaw 2026.9
- **Check:** the agent's sheet shows OpenClaw 2026.9 or newer; Data → History says "No chat history found", or the download stops at the day the agent moved to 2026.9; Recover context says there is nothing to recover after a reset you saw.
- **Cause:** 2026.9 keeps conversations in the agent's own database (`openclaw-agent.sqlite`), and a reset moves the old one to its archive table. The reader looked only at 2026.7's `sessions/*.jsonl` files.
- **Fix:** upgrade. History, Recover context and the after-rebuild context check read the database (current and archived conversations) as well as the older files, each conversation once.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/transcript.ts` — `RENDER_SCRIPT`

### Recover context hands the agent a chat that is still going on (another person's web chat, a group)
- **Check:** the recovered file (`recovered/chat-history-<date>.md` in the agent's workspace) has a conversation the agent is still having; the after-rebuild notice counts it as lost.
- **Cause:** only the single newest conversation was treated as current. An agent has several at once (its Telegram chat, each person's web chat), and every other one was handled as lost to a reset.
- **Fix:** upgrade. Every conversation the session index names as current is left out of recovery and counted as live; only conversations a reset ended are recovered.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/transcript.ts` — `RENDER_SCRIPT`

### Download history says "No chat history found" though the agent has chatted
- **Check:** after the upgrade the same click says "Couldn't read the chat history: chat history unreadable: …" with a reason (`ENOTDIR`, `EACCES`, a database error).
- **Cause:** a sessions folder or database that could not be read was taken as no conversations at all, which hid a damaged or inaccessible store.
- **Fix:** upgrade, then act on the reason: a permissions or disk problem on the agent's volume (`hatchabot doctor`), or a database OpenClaw is still writing (try again in a moment).
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/transcript.ts` — `RENDER_SCRIPT`, `exportTranscript`

### Recover context said it started, but the agent never confirmed
- **Check:** the toast said "Recovering N messages…", no confirmation arrived in the agent's chat, and `recovered/chat-history-<date>.md` is in its workspace.
- **Cause:** the file was written, then the step that asks the agent to read it failed (the container stopped or would not run the command), and that failure was not checked.
- **Fix:** upgrade. The click now says "the history was saved to …, but the agent could not be asked to read it", with the reason; start the agent and press Recover context again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/transcript.ts` — `recoverContext`

### Activity, or an agent's tile, shows a conversation with no last line, and it stays blank until someone writes again
- **Check:** the agent's conversation has messages (open its console), but its row in Activity has no preview; the agent's database was busy or being repaired around the time it last moved.
- **Cause:** a preview read that failed (a busy or damaged database, an unreadable sessions file) was recorded as a conversation with nothing to show, so it was not read again until the conversation next moved.
- **Fix:** upgrade: a failed read is read again on the next poll. On an older version the preview comes back with the next message in that conversation.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/recent.ts` — `RECENT_SCRIPT`, `parseRecentFailed`, `RecentTracker`

### Every agent's memory search is refused ("unauthorized") until a rebuild
- **Check:** `docker logs <prefix>-embed-door` shows no successful calls since a moment the keys file was being rewritten, and the agents' memory search answers 401; `embed-keys.json` in the data directory's `embed/` folder is valid JSON with their keys.
- **Cause:** the memory search door rereads its keys file when its time stamp changes. One read that failed (a file caught mid-write, a moment it could not be read) left it with no keys, and it would not read the same file again until the file next changed — usually the next agent rebuild.
- **Fix:** upgrade; in the meantime, any rebuild (or Settings → Memory search → Restart) rewrites the file and the door reads it again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/embedder/door.ts` — `doorScript`, `loadKeys`

### A deleted or archived agent's memory search key still works on a runner
- **Check:** on the runner, the door's keys file (in its `-embed-keys` volume) still lists the agent's key hash, while `embed-keys.json` under the runner's `embed-hosts/<runner id>/` folder here no longer does.
- **Cause:** the agent was archived or deleted while the runner's memory search service was starting for the first time. The start copied the keys before the change and then took the newer file as already copied, so it was never copied again.
- **Fix:** upgrade; until then, any key change for that runner (a rebuild of one of its agents) or Restart of its service copies the current file.
- **Fixed in:** `v2.160.0`
- **Code:** `src/embedder/embedder.ts` — `syncKeys`, `start`

### A snapshot is refused: "… is there but could not be read" or "Couldn't read … — is the agent healthy?"
- **Check:** the agent page's Snapshots list has no new entry; inside the agent, `ls -l ~/.openclaw/agents/<slug>/agent/` shows the named file with odd permissions, or as a folder.
- **Cause:** one of SOUL.md, AGENTS.md or MEMORY.md is there but cannot be read, or the read itself failed (the container stopped). Before v2.160.0 such a file was left out and the snapshot still looked whole, so undoing a change could not bring that file back.
- **Fix:** make the file readable again (or remove the folder in its place), or start the agent, then take the snapshot again. A restore refuses until the copy taken before it can be made.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/snapshots.ts` — `readCoreFile`, `readCoreFiles`

### Restoring a snapshot does not empty a file that was empty when it was taken
- **Check:** the snapshot's file list (`GET /v1/agents/<id>/snapshots/<snapshot id>`) has no entry for the file.
- **Cause:** before v2.160.0 an empty file was left out of a snapshot, as if it were not there, so a restore left whatever the file held later.
- **Fix:** upgrade; snapshots taken from then on keep an empty file as empty. For an older snapshot, empty the file by hand in the editor.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/snapshots.ts` — `readCoreFile`, `writeSnapshotFiles`

### Restoring a snapshot keeps a MEMORY.md (or other core file) made after it was taken
- **Check:** the snapshot's file list (`GET /v1/agents/<id>/snapshots/<snapshot id>`) has no entry for the file, yet after the restore the agent still has it.
- **Cause:** a snapshot leaves out a core file that was not there when it was taken, and a restore wrote only the files the snapshot holds, so a file made later stayed although the restore said it was done.
- **Fix:** upgrade, then restore the snapshot again: a core file the snapshot lacks is now removed. The copy taken just before the restore ("before restoring …") still holds it, so restoring that one brings it back. A snapshot from before v2.160.0 also lacks a file that was empty then; that file is removed too.
- **Fixed in:** `v2.162.0`
- **Code:** `src/orchestrator/snapshots.ts` — `restoreSnapshot`, `removeCoreFile`, `writeSnapshotFiles`

### After restoring a snapshot, changing a setup value brings back the text that was undone
- **Check:** the agent is a configured template copy (it has Setup values); after a restore, Apply values rewrites SOUL.md or AGENTS.md with the version from before the restore.
- **Cause:** setup values re-render the files from a stored layer with `{{placeholders}}`. A restore put the files back but left the newer layer and values, so the next Apply rendered the undone version.
- **Fix:** upgrade: a snapshot keeps the layer and values with the files, and a restore puts them back. A snapshot from before v2.160.0 makes the restored files the layer, as a direct edit does. Restore again after the upgrade if a value edit already brought the old text back.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/snapshots.ts` — `captureSnapshot`, `restoreParamLayer`; `src/store/store.ts` — `StoredSnapshot`

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

### An adopted agent has files or links its adopt preview never listed, or a link that leads nowhere
- **Check:** the workspace holds symbolic links (`find <workspace> -type l`); the adopted agent's Files show them, though the preview's file count did not include them.
- **Cause:** the preview counted only plain files, but the copy archived the whole folder, links included. A link means something else inside the agent (its target is a path on your machine), so it led nowhere or somewhere unexpected.
- **Fix:** upgrade: the copy is exactly the files the preview lists, and the preview names each link it leaves out ("Not copied — a link: …"). Copy what a link points at into the workspace if the agent needs it, then adopt again. In an agent already adopted, delete the stray links from Files.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/adopt.ts` — `inspectWorkspace`, `packWorkspace`

### Adopting a folder with tens of thousands of files in one place fails late, with an unreadable error
- **Check:** `find <workspace> -maxdepth 1 -type f | wc -l` is over 20,000.
- **Cause:** the 20,000-file limit was checked only on entering a folder, so one flat folder of more files got past the preview and failed while being copied.
- **Fix:** upgrade: the preview now refuses it with "holds over 20000 files". Move the bulk data out and share that folder with the agent instead (`hatchabot folders`).
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/adopt.ts` — `inspectWorkspace`

### Adopt lists an OpenClaw agent as "workspace folder is missing", with a path inside the Hatchabot folder
- **Check:** `~/.openclaw/openclaw.json` gives the agent's `workspace` (or `agentDir`) as `~/…`, and the path the adopt list shows ends in `/~/…`.
- **Cause:** the path was resolved against the server's own folder instead of reading `~` as your home folder, as OpenClaw does.
- **Fix:** upgrade, or write the full path (`/home/<you>/…`) in the OpenClaw config and look again.
- **Fixed in:** `v2.160.0` (#175)
- **Code:** `src/openclaw/configWriter.ts` — `openclawUserPath`; `src/orchestrator/openclawImport.ts` — `discoverOpenclawAgents`

### An adopted agent's tasks or notes point at a folder that does not exist (`/home/node/.openclaw/…-two/…`)
- **Check:** the adopted workspace had a sibling folder whose name starts with the same text (`…/agent` and `…/agent-two`), and the broken path is the sibling's with only its first part rewritten.
- **Cause:** adoption repointed the old workspace path at the container by plain text replacement, which also caught any longer path that started the same way.
- **Fix:** upgrade; only whole paths (or paths inside them) are repointed now. For an agent already adopted, fix the task text (Tasks → edit) and the note, giving the sibling's original path back.
- **Fixed in:** `v2.160.0` (#80)
- **Code:** `src/orchestrator/cronImport.ts` — `pathPattern`, `applyReplacements`, `rewriteWorkspaceFiles`

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

### Web chat: reopening the chat shows less than was said (a picture, an earlier conversation, a repeated notice)
- **Check:** the agent's reply was only a picture, the conversation was reset (`/reset`, or a long quiet spell), or the agent sent the same notice on different days; after closing and reopening 💬 Chat, those messages are missing.
- **Cause:** the history reader kept only text (a picture-only reply had none), merged any two same-text replies in a row as OpenClaw's mirrored copy whatever their time, and on OpenClaw 2026.7 read only the session that is current now.
- **Fix:** upgrade. A picture shows as "[image]", only copies written at the same moment are merged, and on 2026.7 the conversations before a reset are read too when OpenClaw kept the session's trace file (`<id>.trajectory.jsonl`), the one place that names whose conversation it was. 2026.9 keeps every window already.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/webChat.ts` — `HISTORY_SCRIPT`

### Web chat: the conversation is empty after an upgrade or a crash, on OpenClaw 2026.7
- **Check:** after the upgrade the panel says "Couldn't read your conversation just now — try again", and the service log has "web chat history read failed … history read failed: sessions.json".
- **Cause:** a session index (`sessions/sessions.json`) that could not be read or parsed was taken as no conversation, so the panel showed an empty chat instead of a read that failed.
- **Fix:** upgrade. Try again in a moment (OpenClaw may have been writing it); if it stays, the agent's session index is damaged: restart the agent, which rewrites it.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/webChat.ts` — `HISTORY_SCRIPT`

### An agent's Setup log is full of "a web chat guest was refused part of the console"
- **Check:** the agent's Setup log or Activity shows `console.guest_opened` and `console.guest_refused` lines every few minutes, for a member with web chat.
- **Cause:** OpenClaw's console app asks for a few owner-only things each time a guest opens the chat; each was recorded, and the 200-line history filled with them.
- **Fix:** upgrade to v2.158.3 (the startup refusals go to the service log; a visit is recorded at most once an hour, with its device). If you don't recognise the visits, the note on each says the browser and address; remove that member's web chat on the agent's Sharing tab, or sign that account out everywhere.
- **Fixed in:** `v2.158.3`
- **Code:** `src/api/guestConsoleLog.ts` — `GuestConsoleLog`

### An agent's icon shows unread after a Telegram chat, with nothing new in its console
- **Check:** the conversation's record (the agent's session records) names Telegram only as its `origin.provider`, with no `lastChannel` or `lastTo`.
- **Cause:** the unread check gave up on the record before reading its origin, and counted it as the console's.
- **Fix:** upgrade: such a conversation counts as Telegram's, which shows its own unread mark.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/unread.ts` — `consoleActivity`

### A console's link (…/#console=<name>) opened right after closing a console does nothing
- **Check:** the console had just been closed; the address bar lost the `#console=` part and no console opened. Opening the link again works.
- **Cause:** the browser sends a dialog's close event a moment after it closes (Chrome, with its next frame). When that came after the new address but before the page read it, the event took the address out as if it were the closed console's.
- **Fix:** upgrade, or open the link again. The close event now clears only an address the closed console put there.
- **Fixed in:** `v2.162.0`
- **Code:** `web/index.html` — `consoleUnmark`, `consoleFromHash`

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

### Adding another Hatchabot server does nothing
- **Check:** a name, address or token field is empty, and no message appears.
- **Cause:** the form wrote its error into the AI tab's error line, which is hidden on that tab.
- **Fix:** fill in all three fields, or upgrade. The form is now under Settings → Advanced → Other Hatchabot servers and shows its errors under it.
- **Fixed in:** `v2.157.0`
- **Code:** `web/index.html` — `addPeer`

### A failed move says the copy on the other machine "couldn't be cleaned up", and Start is refused
- **Check:** the agent's page or Alerts shows a held "Move to …" whose outcome says its copy there could not be removed; `hatchabot ops <agent>` lists the choices `remove-copy` and `copy-removed`; `docker ps` on the other machine may still list the agent's container.
- **Cause:** the move failed, and the copy it had started on the other machine could not be removed or confirmed stopped (its machine hung or stopped answering). Starting the agent where it was would let two copies answer the same bot. Before v2.160.0 the move was recorded as failed, which is over, so Start and wake were allowed while that copy might still run.
- **Fix:** choose **Remove the copy on …** once that machine answers; or remove the container there yourself (`docker rm -f` on the agent's container) and choose **I removed the copy on …** — checked when the machine answers, taken at your word when it does not. Either starts it where it was if it was running. From the CLI: `hatchabot ops recover <op-id> remove-copy`.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/moveHost.ts` — `orphanChoices`, `settleOrphan`, `putBack`

### A move to another Hatchabot says "This server's runtime image is OpenClaw 2026.9.6, older than the agent's 2026.9.6-rc.1"
- **Check:** the agent runs a release candidate (`-rc.N`, `-beta.N`) and the destination runs that version's final release or later.
- **Cause:** versions were compared number by number, so "rc.1" read as a later build than the release it comes before.
- **Fix:** upgrade the sending Hatchabot: since v2.160.0 a prerelease sorts before its release, and a numbered build ("-2") after it.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/migrate.ts` — `versionBehind`

### A new runner never connects ("Permission denied (publickey)") when your home folder's name has a space
- **Check:** in `~/.ssh/config`, the block under `# agentclaw-runner: <host>` has an `IdentityFile` line whose path has a space and no quotes around it.
- **Cause:** ssh reads an unquoted space as the end of the value, so it looked for a key file that does not exist.
- **Fix:** upgrade, delete that marked block from `~/.ssh/config` (a block already there is never rewritten), then remove the runner and add it again. Or put the path in double quotes by hand.
- **Fixed in:** `v2.160.0` (#153)
- **Code:** `src/orchestrator/runnerSetup.ts` — `sshConfigPath`, `ensureSshConfigBlock`

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

### Deleting a backup says "The … backup is still being written"
- **Check:** Settings → Backups shows that day's set as running, or `<backup dir>/<date>/.backup-lock/pid` names a process that `ps -p` finds.
- **Cause:** a backup run is writing that set. Before v2.160.0 Delete removed it anyway, lock and all: the run went on writing into nothing, and another run could start on the same day.
- **Fix:** wait for the run to finish, then delete. A lock left by a killed run does not block the delete.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/backups.ts` — `pruneBackup`, `lockHeld`

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

### An agent's Recovery row says "left out of the last N backups: its machine was asleep or offline"
- **Check:** Settings → Backups, the "Left out of" column; the machine line shows the runner "not answering"; `<set>/backup-status.json` lists the volume under `skipped`.
- **Cause:** the agent lives on a runner that did not answer at the 03:30 backup, so its volume was skipped (not failed); retention keeps its last copy.
- **Fix:** keep the runner awake at backup time, or run **Back up now** while it is; meanwhile **Download copy** keeps a copy by hand.
- **Fixed in:** `v2.157.0`
- **Code:** `src/orchestrator/recoveryReadiness.ts` — `computeReadiness`

### The last restore drill failed (Alerts: "the last restore drill (<date>) failed")
- **Check:** the drill line in Settings → Backups; the newest `<backups>/drills/*.json`, whose `volumes[].note` is unreadable, layout, extract, timeout or nodocker, and its `database` and `key` fields.
- **Cause:** an archive is torn or holds no OpenClaw files, did not extract into a fresh volume, took over 15 minutes, or Docker did not answer; or the database copy or the saved key did not pass.
- **Fix:** for an archive, **Back up now** and drill again; for nodocker, start Docker; for the key, compare `secret-key.env` in the set with your `.env`.
- **Fixed in:** `v2.157.0`
- **Code:** `scripts/restore-drill.sh` — `write_record`

### `restore-drill.sh` stops at once with "Another restore drill (pid N) is running"
- **Check:** `<backups>/drills/.lock/pid`, and whether that process is alive.
- **Cause:** one drill at a time — a scheduled drill, Run a drill now, or the live test is already running.
- **Fix:** wait for it; a lock left by a killed drill is taken over by the next one.
- **Fixed in:** `v2.157.0`
- **Code:** `scripts/restore-drill.sh` — `take_lock`

### Restore from a backup: "Its runtime could not be confirmed stopped … nothing was changed"
- **Check:** the agent's operation says the restore was rolled back with this message; `docker inspect <agent container>` hangs or errors, or its runner is asleep or off.
- **Cause:** a restore replaces the whole volume, so Hatchabot first stops the runtime and confirms it is down; it refuses when the machine doesn't answer or the container is still running after the stop.
- **Fix:** wake the runner or bring Docker back, then restore again; for a held restore, choose Finish the restore or Put back the copy from before again.
- **Fixed in:** `v2.158.1`
- **Code:** `src/orchestrator/backups.ts` — `confirmStopped`, `recoverBackupRestore`

### A held restore says it "stays stopped", but the agent is still running
- **Check:** Alerts shows a held "Restore from a backup"; `docker ps` (on its runner, if it lives on one) lists the agent's container running; the trail has `restore.not_stopped`.
- **Cause:** after a restart cut a restore off, Hatchabot stopped the agent without checking the stop took. A machine that did not answer, or a stop that did nothing, was still recorded as stopped. Before v2.160.0 the outcome said "It stays stopped until you choose" either way.
- **Fix:** upgrade. The outcome now says when the runtime "could not be confirmed stopped", and the agent is not marked stopped. Wake the machine or bring Docker back, then choose Finish the restore or Put back the copy from before. Each choice stops the agent and checks it is down before touching its memory.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/backups.ts` — `resumeBackupRestore`, `confirmStopped`

### After "Put back the copy from before", a removed member or an old bot works again
- **Check:** the agent's held restore was settled with **Put back the copy from before**. Since the restore began, a member was removed, its bot changed, or a Google account was detached, and the agent still answers that member, polls the old bot, or `gog auth list --json` still names the account.
- **Cause:** the copy from before is how the agent was when the restore began, which may be days earlier. Before v2.160.0, putting it back started it with that copy's members and bots, without putting today's settings over it. A restore's restart also skipped what a Start runs, so Google accounts detached or queued for removal stayed until the next Start.
- **Fix:** upgrade, then Rebuild the agent to put its current settings back. Put back now writes today's members, bot and settings over the copy before it starts, and a restore's restart runs the same steps as Start. If that cannot be done, the restore stays held and the agent stays stopped.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/backups.ts` — `recoverBackupRestore`, `restartAfterRestore`; `src/api/routes.ts` — `startHooksFor`

### After a restore whose settings "couldn't all be put back", an old Slack, Discord or Google account works
- **Check:** the restore's outcome says its current settings couldn't all be put back (for example, its AI source is gone). The agent still answers on a Slack or Discord bot it no longer has in the app, or `gog auth list --json` names a Google account that is no longer attached.
- **Cause:** when the full re-apply fails, a restore falls back to the safety minimum. Before v2.160.0 that kept only the current Telegram bot and removed revoked members, so Slack and Discord tokens and Google accounts from the backup stayed and ran. The outcome said only "model, AI source" were left out.
- **Fix:** upgrade, then Rebuild the agent once its AI source works again. That writes its current Slack, Discord and Google accounts. The fallback now turns Slack and Discord off until the next build, and a restore's restart removes Google accounts that are not attached now. On an older version, Rebuild the agent, or detach and reattach its Slack or Discord.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/backups.ts` — `applyCurrentSettingsOver`; `src/orchestrator/members.ts` — `DROP_CHAT_ACCOUNTS_SCRIPT`

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

### A spike warning never arrived on Telegram, but Usage shows the spike
- **Check:** Usage's spike line says "told with its loop", or the agent had an open loop (🔁) told that day.
- **Cause:** one cause, one message a day: the loop's message already covered the spike.
- **Fix:** none needed; the loop's item under Usage → Recommended carries the spike.
- **Fixed in:** `v2.158.0`
- **Code:** `src/orchestrator/usageAlerts.ts` — `runUsageAlerts`; `src/orchestrator/tokenWatch.ts` — `loopCovering`

### A budget at 80% or a "tell me every $X" step no longer shows under Alerts
- **Check:** the agent's Usage tab → Recommended, and the tile's tooltip.
- **Cause:** since v2.158.0, Alerts keeps only a live loop, a budget at 100% and today's spike; an 80% budget before mid-month is a Recommended item; steps are still messaged and shown on the tile.
- **Fix:** none needed; look under Usage → Recommended.
- **Fixed in:** `v2.158.0`
- **Code:** `src/orchestrator/recommendations.ts` — `buildRecommendations`

### "Compact it now" seems to do nothing, and a second click says "Already compacted"
- **Check:** the agent's chat has "🗜 Hatchabot: Compacted …" and then "Compaction of … failed: Already compacted"; the Usage advice still showed the old size after the first one.
- **Cause:** a summarising compaction runs in the background for minutes, and the advice read the conversation's size at its last turn, from before the compaction, so the button stayed. A second click found nothing new to compact, and OpenClaw's "Already compacted" was reported as a failure.
- **Fix:** upgrade. The card now says "is being compacted" while it runs (with no second button), takes the size the compaction left once it is done, and "Already compacted" counts as done. The size is measured again at the agent's next turn.
- **Fixed in:** `v2.159.1`
- **Code:** `src/orchestrator/tokenHealth.ts` — `tokenHealthRow`; `src/orchestrator/compaction.ts` — `parseCompactResult`; `src/orchestrator/recommendations.ts` — `conversationItems`

### The token ledger shows a compaction "running" that ended long ago
- **Check:** the manager's `get_token_health` or the ledger lists a compaction with outcome `running` from hours or days ago, while a new compaction of the same agent starts normally.
- **Cause:** when the compaction command could not even be started (the exec threw instead of answering), the in-memory lock was let go but the ledger row was never closed.
- **Fix:** upgrade. Every way out of a compaction now records it, a run that threw as `failed` with the reason. A row left from before stays as it is; it does no harm.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/compaction.ts` — `compactAgent`

### The machine's budget is used up and set to pause, but an agent keeps running (it was on a cheaper model)
- **Check:** Settings → Budgets shows the machine's budget past 100% with "pausing at the limit"; the agent still running has its own budget set to "cheaper" and was moved to a cheaper model this month.
- **Cause:** before v2.160.0 an agent a budget had moved to a cheaper model counted as "already acted on", so the machine's pause skipped it and it went on spending past the hard limit.
- **Fix:** upgrade. A pause now wins over a cheaper model: the agent is paused, its own model is put back so it starts on it, and when the pause ends a budget still reached moves it to the cheaper model again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/budgets.ts` — `runBudgets`

### The budget message says the agent "was already on the cheapest model", but it still runs on its expensive one
- **Check:** the agent's Setup log has `budget.downgrade_failed`; its model is unchanged.
- **Cause:** before v2.160.0 a switch that failed was read as "nothing cheaper on its source": the 100% message went out, once, saying so.
- **Fix:** upgrade. A failed switch is tried again on the next budget pass (every 10 minutes), and the 100% message waits until it worked.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/budgets.ts` — `budget.downgrade_failed`

### A budget's 80% or 100% message, or a "tell me every $X" step, never reached the chat
- **Check:** the Setup log's `budget.told` or `budget.step_told` line says `told: false`; or the machine's budget passed 80% before there was a Hatchabot agent to tell it on.
- **Cause:** before v2.160.0 a mark counted as told when the message was attempted, so one that failed (or had no Hatchabot agent to go through) was never sent again.
- **Fix:** upgrade. A mark is told only once the message got through; until then each budget pass tries again, including after the Hatchabot agent is made. Link your chat (message the Hatchabot agent once) so there is somewhere to send it.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/budgets.ts` — `budgetMark`; `src/store/store.ts` — `budgetMark`

### Someone who wrote to an agent paused by its budget got no reply
- **Check:** the agent is paused by its budget; Telegram was unreachable for a moment around their message.
- **Cause:** before v2.160.0 the message was marked answered before the reply was sent, so a reply that failed was never sent again.
- **Fix:** upgrade. A message counts as answered only once the reply went out; the next sweep (each minute) tries again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/budgets.ts` — `pausedReplySweep`

### "Set a $… budget" or "Raise it to $…" fails: "usd: a number from 1 to 100000"
- **Check:** the button's figure is over $100,000 (an agent that costs more than about $80,000 a month at API prices).
- **Cause:** before v2.160.0 the suggested budget had no upper bound, while the budget route accepts at most $100,000.
- **Fix:** upgrade: suggestions stop at $100,000. Set a lower budget by hand, or make the agent cheaper.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/budgets.ts` — `suggestBudget`

### The Hatchabot agent's budget card said "it keeps working past it", but at the limit the agent paused or changed model
- **Check:** the card had no pausing or cheaper wording; the agent's budget was already set to pause or cheaper before the card.
- **Cause:** before v2.160.0 a `set_budget` card without an action described a warn-only budget, while the change kept the budget's existing pause or cheaper action.
- **Fix:** upgrade. The card reads the budget's current action when it is written and the change carries exactly that; to change the action, ask for it by name.
- **Fixed in:** `v2.160.0`
- **Code:** `src/mgmt/restTools.ts` — `set_budget`

### Clearing one spike warning in Usage cleared all of them
- **Check:** a request to `/v1/usage/alerts/dismiss` with an agent and time that were not text (a script or an older client).
- **Cause:** before v2.160.0 an agent or time of the wrong type was read as "neither", which clears every warning.
- **Fix:** upgrade: such a request is refused (400) and clears nothing.
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/routes.ts` — `/v1/usage/alerts/dismiss`

### A Recommended item's button does something other than what the item says (for example "Raise it" removes the budget)
- **Check:** the item is marked as the Hatchabot agent's proposal, and the card it confirms (on the agent's chat) differs from the item's title.
- **Cause:** before v2.160.0 a pending card was merged into an item for the same agent whatever it did, so a card that removed a budget took the place of "Raise it to $…".
- **Fix:** upgrade. A card is merged only when it makes exactly the item's change; any other card is listed as its own item, in its own words.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/recommendations.ts` — `matchCard`

### A set_model card warns of more failed turns than the agent had
- **Check:** `get_model_scorecard` (or the agent's Usage) shows the same model twice, once with a vendor prefix (`anthropic/…`); the card's count is about double.
- **Cause:** before v2.160.0 the check summed each spelling of a model together with its other spellings, so failures were counted once per spelling.
- **Fix:** upgrade: each model is counted once, whatever its spellings.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/modelLedger.ts` — `assessModelChange`

### The scorecard says "ok" evidence for a model the agent has only just moved to (a model Hatchabot has no price for)
- **Check:** the agent's model and its earlier one are both outside Hatchabot's model list (a local or other vendor's model); "turns on its model" counts the earlier model's turns.
- **Cause:** before v2.160.0 two models outside the list looked the same (neither had a catalog id), so one's history counted as experience on the other.
- **Fix:** upgrade: models outside the list are compared by name.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/modelScorecard.ts` — `scoreAgent`

### The weekly token review still runs although `HATCHABOT_MODEL_REVIEW=off`
- **Check:** the Hatchabot agent's scheduled tasks list "Weekly token review" (or "Weekly model review"); the agent was imported or restored from a copy made while the review was on.
- **Cause:** before v2.160.0 turning it off removed the task only when this install had a record of making it; a task that came with the agent's volume was kept.
- **Fix:** upgrade and rebuild the Hatchabot agent: with the setting off, a build looks for the task by name and removes it. Or delete the task by hand.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/modelReview.ts` — `syncModelReviewCron`

### Two agents keep consulting each other, but no loop shows under Alerts
- **Check:** the agents' consult log has a fresh back-and-forth, and an older, longer one earlier the same day.
- **Cause:** before v2.160.0 the watcher kept the longest run of consults, so an older long run (already over) hid a shorter one happening now.
- **Fix:** upgrade: the latest qualifying run is the one judged and reported.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/tokenHealth.ts` — `loopSignals`

### A new agent's first tokens are missing from Usage and from its AI source's figures
- **Check:** the agent's first reading (zero) is just before the window shown; its first rise inside the window is missing.
- **Cause:** before v2.160.0 a window started from the last reading above zero before it, and a new agent had none, so its first rise had no starting point and was dropped.
- **Fix:** upgrade: with no earlier reading above zero, a new agent's first zero is the starting point.
- **Fixed in:** `v2.160.0`
- **Code:** `src/store/store.ts` — `BASELINE_AT`

### Telegram: "used N tokens in the last 24 hours — after a quiet week" for an agent that is always this busy
- **Check:** the agent is older than its first token reading (it was added from another install, or measuring started late); Usage shows no readings for it before today.
- **Cause:** before v2.160.0 how long an agent had been measured came from the oldest reading of any agent, so an agent first measured today was compared with a week of zeros it was never measured for.
- **Fix:** upgrade: each agent's own first reading decides; until it has three measured days it is judged on size alone.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/usageAlerts.ts` — `findUsageSpikes`

### An AI source's failed or rate-limited calls are counted twice, missing, or on the wrong source
- **Check:** after a rebuild (whose sample overlapped the timer's), the failed calls are about double; or calls logged in the same millisecond are missing; or after a source switch not yet rebuilt, the old source's calls show under the new one.
- **Cause:** before v2.160.0 two samples of one agent could run at once and both count the same lines; the read cursor kept milliseconds, so a later line in that millisecond was skipped; and calls were filed under the saved source rather than the one the container runs.
- **Fix:** upgrade. Samples of one agent run one at a time, the cursor keeps docker's nanoseconds, and calls are filed under the running source until the rebuild.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/sourceUsage.ts` — `sampleAgentUsage`, `logKey`

### After a rebuild that switched an agent's AI source, its last hour of calls shows under both sources
- **Check:** Usage for the old and the new source both show the same calls in the hour before the rebuild (the agent's requests are about doubled across the two).
- **Cause:** before v2.162.0 each sample rewrites the last hour of successful calls from the transcripts, and filed all of it under the source running now, while the old source still had those calls.
- **Fix:** upgrade. A rebuild that changes the source records when it did; calls before that time stay with the old source and only later ones go to the new source. Counts from before the upgrade are not corrected.
- **Fixed in:** `v2.162.0`
- **Code:** `src/orchestrator/sourceUsage.ts` — `sampleAgentUsage`; `src/store/store.ts` — `setAgentApplied`

### The Cost view's figures stay on the old window after pressing another (1 hr, 1 day …)
- **Check:** the pill is on the new window but the chips still show the old one's suffix (for example `/wk`), until the next poll five minutes later.
- **Cause:** before v2.160.0 a pill pressed while the previous figures were still loading was dropped, and the discarded answer still counted as fresh.
- **Fix:** upgrade: the new window's figures are read as soon as the earlier answer is back. Reloading the page also shows them.
- **Fixed in:** `v2.160.0`
- **Code:** `web/index.html` — `v2LoadCosts`

### A context cap removed or moved, but a hand edit of the provider vanished, or the old model still compacts early
- **Check:** in the agent's console, `openclaw config get models.providers.<provider>`: a `baseUrl` or model row you added is gone after taking a context cap off, or after a source switch the old provider still has a row with `contextTokens`; the event log has `token.context_cap_failed`.
- **Cause:** taking the last cap off ran `config unset` on the whole provider entry without checking it was still what Hatchabot had read; and after a source switch a failed removal of the old provider's cap was forgotten once the new cap was written.
- **Fix:** upgrade; put back the hand edit, or take the stale `contextTokens` row off by hand. Since v2.160.0 the entry is read again just before the unset and left alone if it changed, and the old cap stays on record until it is off, so the next rebuild or change retries it.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/compaction.ts` — `syncContextCap`, `writeEntry`

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

### After editing a task in the app, its results go to the owner's chat instead of a member's chat or a group
- **Check:** the task was edited with ✏️ Edit in the agent's Schedule tab; its delivery (`openclaw cron list --json` in the agent) now names the owner, and its id changed.
- **Cause:** the app's edit deleted the task and added a new one, and a new task is always sent to the owner's chat (or the console conversation), so wherever the old one posted was lost.
- **Fix:** upgrade: an edit now changes the task in place and sends only the changed name, message or schedule, so where it posts, whether it is quiet or paused, and its run history stay. A task already moved has to be pointed back by asking the agent.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/crons.ts` — `editCron`; `web/index.html` — `addCronJob`

### An agent made from a template posts the results of a task that was quiet in the original
- **Check:** in the original agent the task is quiet (its runs are only read in the app); in the copy (imported, accepted from a share, or cloned) the same task posts into the chat.
- **Cause:** a template carried each task's name, schedule and message, but not that it was quiet, and the copy made every task announce.
- **Fix:** upgrade, then export the template again (a template exported before the fix does not say which tasks were quiet, so its tasks still announce). In a copy already made, ask the agent to make the task quiet.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/template.ts` — `exportTemplate`; `src/orchestrator/provision.ts` — `getPendingSchedules`

### A copy made from a template has two of OpenClaw's own upkeep tasks (memory dreaming, the weekly skill review)
- **Check:** the copy's Scheduled tasks list shows one of OpenClaw's tasks twice: once marked as OpenClaw's, once as an ordinary task.
- **Cause:** before v2.160.0 an export carried OpenClaw's own tasks as ordinary ones, and every copy also gets its own from OpenClaw.
- **Fix:** upgrade and export again; in a copy already made, delete the ordinary duplicate.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/template.ts` — `exportTemplate`; `src/orchestrator/crons.ts` — `normalizeCron`

### Share, Clone or New child: "Couldn't read its scheduled tasks, so the copy would have none — nothing was exported"
- **Check:** the agent's Scheduled tasks list does not load either, or `openclaw cron list --json` inside the agent fails.
- **Cause:** the agent's gateway did not answer for its task list (still starting, or unwell). Before v2.160.0 the copy was made anyway, with no tasks, and nothing said so.
- **Fix:** wait until the task list loads (restart the agent if it does not), then try again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/template.ts` — `exportTemplate`; `src/orchestrator/crons.ts` — `listCrons`

### Share, Clone or New child: "It has N scheduled tasks switched on; a template carries at most 12"
- **Check:** the agent's Scheduled tasks list has more than 12 tasks that run a message and are switched on.
- **Cause:** a template holds at most 12 tasks (older Hatchabot releases refuse a file with more). Before v2.160.0 the rest were left out without a word.
- **Fix:** switch off or remove the tasks a copy does not need (switched-off tasks are not copied), then share again; add them to the copy afterwards if it needs them.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/template.ts` — `exportTemplate`, `MAX_TEMPLATE_SCHEDULES`

### Share, Clone or New child: "… is there but could not be read — nothing was exported"
- **Check:** inside the agent, `ls -l ~/.openclaw/agents/<slug>/agent/` shows the named file with odd permissions, or as a folder; or the agent is not running properly.
- **Cause:** its SOUL.md, AGENTS.md or MEMORY.md is there but could not be read. Before v2.160.0 the file went into the copy empty, so the copy had no persona or no instructions.
- **Fix:** make the file readable again (or remove the folder in its place), or restart the agent, then try again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/template.ts` — `exportTemplate`; `src/orchestrator/snapshots.ts` — `readCoreFile`

### Share, Clone or New child: "Its files use N setup fields; a template carries at most 24"
- **Check:** count the `{{placeholders}}` in SOUL.md, AGENTS.md and the description, plus the declared Setup fields.
- **Cause:** a template holds at most 24 setup fields. Before v2.160.0 the rest were cut off: the copy never asked for them and kept their `{{placeholders}}` in its instructions.
- **Fix:** write the fixed text in place of some placeholders, or remove the ones no copy needs, then try again. The message names the ones past the limit.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/template.ts` — `collectParameters`

### A child or a recipient of a configured agent keeps the author's setup values, whatever they answer
- **Check:** the agent the copy came from has Setup values filled in; the copy asks for the fields, but its SOUL.md or AGENTS.md has the author's answers where the copy's should be.
- **Cause:** before v2.160.0 an export read the agent's files as they are, with its own values filled in, so the copy got the field list but no `{{placeholders}}` to put its answers in.
- **Fix:** upgrade and share or make the child (New child) again: an agent with Setup fields now travels as its placeholder layer. In a copy already made, change the text by hand or with Setup values after adding the placeholders back.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/template.ts` — `exportTemplate`

### Import or New child: "… must be yes or no (true/false)"
- **Check:** the answer given for a yes/no setup field (from the CLI, a script, or the field's declared default) is not one of yes, no, true, false, on, off, 1, 0.
- **Cause:** before v2.160.0 any other answer, such as a misspelt "tru", was taken as no and turned the option off without a word.
- **Fix:** give yes or no; if the template's own default is the misspelt one, fix it in the master's Setup fields and share again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/template.ts` — `resolveParamValues`

### A choice in a template's setup fields is never accepted, or a template with two fields of the same key imports wrongly
- **Check:** the field's options in the template have spaces before or after them (`" daily"`), or two of its setup fields share one key.
- **Cause:** answers were compared trimmed against options that were not, so such an option could never be picked; and two fields of one key overwrote each other's answer. Before v2.160.0 both were accepted when the template was made or imported.
- **Fix:** upgrade: options are trimmed where they are declared and compared trimmed, and a template whose keys repeat is refused as malformed. Fix the repeated key in the master and share again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/template.ts` — `TemplateParamSchema`, `parseTemplate`, `resolveParamValues`

### A task added while the agent was being moved or exported is missing from the moved copy
- **Check:** the task was added (the Schedule tab, `hatchabot tasks`, or the Hatchabot agent) while a move, export or rebuild of that agent was under way; the agent's timeline has `cron.created` during the operation.
- **Cause:** adding a task did not wait for the agent's other operations, unlike enabling, editing or deleting one, so it could land in the runtime that was going away.
- **Fix:** upgrade: adding a task now says "Another operation is already running on this agent" until the operation ends. Add the task again on the copy that carries on.
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/crons'`

### A one-time task shows just "at" with no time
- **Check:** `openclaw cron list --json` in the agent gives the task's `schedule.at` as a date string, not a number; often a task brought in from another OpenClaw.
- **Cause:** only a time in milliseconds was read; a date string was dropped.
- **Fix:** upgrade: both are read, and the task shows "once at" its time.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/crons.ts` — `atMsOf`

### `hatchabot tasks … runs` says a task "has not run yet", though the list shows a last run
- **Check:** the agent's gateway was slow or restarting at the time; `openclaw cron runs --id <task>` in the agent fails or prints no JSON.
- **Cause:** a history that could not be read was answered as an empty one.
- **Fix:** upgrade: it now says "Couldn't read that task's runs just now — try again in a moment." Try again once the agent answers.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/crons.ts` — `listCronRuns`

### A task the agent made before you linked your chat never posts to you, even after linking
- **Check:** the task is quiet (`openclaw cron list --json` in the agent shows `delivery.mode` `none`); it was made while Hatchabot did not yet know your id on the agent's chat app; the timeline has `cron.retargeted` from then.
- **Cause:** with no one to post to, the daily repair made such a task quiet; once quiet it no longer looked like one to repair, so linking your chat later did not bring it back.
- **Fix:** upgrade: a task made quiet this way is remembered and pointed at your chat on the next pass after you are linked (after a start, or daily). A task made quiet before the upgrade is not known to have been: ask the agent to post its results to you.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/crons.ts` — `retargetImplicitCrons`; `src/store/store.ts` — `quietedCrons`

### A task's schedule reads "every 0m", or a slightly wrong number of minutes
- **Check:** the task runs on an interval that is not whole minutes (`openclaw cron list --json` in the agent: `schedule.everyMs` such as 15000 or 90000).
- **Cause:** the Schedule tab rounded intervals to whole minutes; the task itself ran on its real interval.
- **Fix:** upgrade: intervals show to the second ("every 15s", "every 1m 30s").
- **Fixed in:** `v2.160.0`
- **Code:** `web/index.html` — `cronScheduleLabel`

### Editing a task on one agent while a save on another was still going lost the edit
- **Check:** a task was saved in one agent's Schedule tab, and another agent's tab was opened and a task there loaded with ✏️ Edit before the first save finished; the form emptied and went back to "Add task".
- **Cause:** when the first save finished, it emptied the form and left edit mode on whatever agent was open by then. Before the in-place edit of v2.160.0 it could also delete the task loaded on the second agent.
- **Fix:** upgrade: a save goes to the agent it was made on and only empties the form while that agent and that edit are still open.
- **Fixed in:** `v2.160.0`
- **Code:** `web/index.html` — `addCronJob`

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

### `hatchabot reach on --invited-only` fails with "unknown option --invited-only"
- **Check:** the command stops before asking anything, with that error.
- **Cause:** the help text documented the flag, but the CLI's list of known flags left it out.
- **Fix:** upgrade. Until then, turn on "only invited people" in the app (Settings → You → Reach it from anywhere), then run `hatchabot reach on`.
- **Fixed in:** `v2.160.0` (#84)
- **Code:** `src/cli.ts` — `parseArgs`

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

### The Hatchabot agent says ✅ for a rebuild or an archive that did not happen
- **Check:** the confirmed card in its chat shows ✅, but the agent's page (or `hbt ops`) shows that operation failed or rolled back, or the rebuild was still running when ✅ appeared.
- **Cause:** a confirmed rebuild was reported done as soon as it was accepted, and a long change (archive, move, restore) that ended failed was shown as ✅ with the failure text under it.
- **Fix:** upgrade. Since v2.160.0 the card follows the operation to its end and says "⚠ Failed — …" with the reason when it did not happen; check the agent's page and retry from there.
- **Fixed in:** `v2.160.0`
- **Code:** `src/mgmt/broker.ts` — `followOperation`, `#rebuild`

### The Hatchabot agent's search_source finds nothing for a pattern like "a|b"
- **Check:** the search used a regular expression without `regex: true`.
- **Cause:** since v2.158.3 search_source looks for plain text by default.
- **Fix:** ask again with `regex: true`, or search for plain text.
- **Fixed in:** `v2.158.3`
- **Code:** `src/orchestrator/problemReport.ts` — `searchSource`

### search_source answers "The search took longer than 3 s and was stopped"
- **Check:** the query is a regular expression with nested repeats.
- **Cause:** expression searches run in a worker stopped at the time limit, so the app stays responsive.
- **Fix:** search for plain text, or use a simpler expression.
- **Fixed in:** `v2.158.3`
- **Code:** `src/orchestrator/problemReport.ts` — `searchSource`, `SEARCH_LIMITS`

### read_source or search_source says "Outside the source." for a path that exists
- **Check:** `ls -l` on the path in the install folder shows a link.
- **Cause:** a link is judged by where it leads; a target outside the readable set, or a dangling link, is refused.
- **Fix:** none needed if it points outside the shipped source; otherwise replace the link with the file.
- **Fixed in:** `v2.158.3`
- **Code:** `src/orchestrator/problemReport.ts` — `sourcePath`, `realInside`

### A problem report shows `<name>` where an agent's or person's name was, even after editing it back
- **Check:** the masked word is one of your agents' names or slugs, a member's name, or a machine's name.
- **Cause:** since v2.158.3 reports mask every private name the app knows, edits included, because the issue is public.
- **Fix:** describe the agent another way ("my recipe agent").
- **Fixed in:** `v2.158.3`
- **Code:** `src/orchestrator/problemReport.ts` — `redactForPublic`

### Report a problem fails with "URI malformed" when the report holds emoji
- **Check:** the title is long or the report is long enough to be cut for the link, and it has emoji or other characters outside the basic plane near the cut.
- **Cause:** the report was cut in the middle of such a character, and the half left behind cannot go in a link.
- **Fix:** upgrade: cuts now fall between characters. On an older version, shorten the title or remove the emoji near its end.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/problemReport.ts` — `buildReport`, `issueUrl`

### Report a problem shows a different draft from the one you clicked
- **Check:** you clicked one draft, then another before the first had opened.
- **Cause:** whichever draft's load came back last was shown, even when it was the first one clicked; Open on GitHub and Discard then acted on it.
- **Fix:** upgrade: only the draft clicked last is shown. Check the title before filing.
- **Fixed in:** `v2.160.0`
- **Code:** `web/index.html` — `reportShow`, `reportGen`

### A discarded report draft comes back in the Drafts list
- **Check:** the draft reappears when Report a problem is opened again.
- **Cause:** a discard the server did not carry out (it was busy, or the connection dropped) was shown as done.
- **Fix:** upgrade: a failed discard says "The draft was not discarded" and keeps it open. Press Discard again.
- **Fixed in:** `v2.160.0`
- **Code:** `web/index.html` — `reportDiscard`

### A problem report draft still shows a credential, or the start of one
- **Check:** the value is in the draft's Recent failures, Agent log or your own words, and it is one of an agent's settings, its bot token or AI key.
- **Cause:** a report not about one agent knew only this server's own credential settings, though its Recent failures come from every agent you can see. And a setting written `password=$…` (a value starting with `$`) or `password = …` (spaces, no quotes) was not recognised as a credential, in reports and in failure messages alike. The start of one: long text was cut to fit before it was masked, and a known value cut in two no longer matched.
- **Fix:** upgrade: every agent whose failures a report carries has its credentials masked, and both forms are masked (`$NAME`, `${name}` and `${{ … }}` stay: they are references); text is masked whole, then cut. Before that, delete the value from the draft before filing.
- **Fixed in:** `v2.162.0`
- **Code:** `src/api/routes.ts` — `reportRedaction`, `reportAgents`; `src/domain/redact.ts` — `redactCredentialFields`, `isReference`, `isCode`; `src/orchestrator/problemReport.ts` — `buildReport`, `boundInput`

### A problem report shows a private IPv6 address (`fd…`, `fe80::…`)
- **Check:** the draft shows an address starting `fc`, `fd` or `fe80`, or `::ffff:` with a private IPv4 address, where a private IPv4 address would show `<private-ip>`.
- **Cause:** reports masked private IPv4 addresses only; a runner reached over IPv6 (a tailnet's `fd7a:…`, say) kept its address.
- **Fix:** upgrade: private, link-local, loopback and mapped private IPv6 addresses show `<private-ip>`. Before that, delete the address from the draft before filing.
- **Fixed in:** `v2.162.0`
- **Code:** `src/orchestrator/problemReport.ts` — `redactForPublic`, `isPrivateV6`

### On a Claude subscription, the Hatchabot agent says it will do something, then nothing happens (no card)
- **Check:** the reply ends with a long JSON object (`{"tool": …}`), shown as text, and no confirmation card appears; the AI source behind the Hatchabot agent is a setup-token or machine login (Settings → AI).
- **Cause:** on a subscription the model is reached through the Claude CLI, which answers in text; a tool call after a sentence was looked for among only the last 20 opening braces, so a call with many nested objects (a schedule, a list of rows) was never found and was shown as prose.
- **Fix:** upgrade. The call is found by matching its braces, however deep it nests.
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/cliChatModel.ts` — `parseToolAfterProse`, `closingBrace`

### On a Claude subscription, the Hatchabot agent acts as if it had said what you asked
- **Check:** the AI source behind the Hatchabot agent is a setup-token or machine login, and it replies to your request as its own earlier words ("as I said…"), or repeats an action it thinks it proposed.
- **Cause:** when the conversation was turned into the CLI's text prompt, a message of yours stored as content blocks was labelled "You:", the model's own voice.
- **Fix:** upgrade. Each message is labelled by who sent it, in whatever form it is stored.
- **Fixed in:** `v2.160.0`
- **Code:** `src/api/cliChatModel.ts` — `renderConversation`

### The Hatchabot agent quotes a web page that is not the search result it named
- **Check:** after many searches in one session (more than 60 results in all), the agent opens result N and reports a page about something else.
- **Cause:** only the latest 60 results are kept, and dropping the oldest renumbered the rest, so a number given out earlier pointed at a different page.
- **Fix:** upgrade. A result keeps its number for good; once it is too old to open, `read_result` says "Result N has expired … Search again."
- **Fixed in:** `v2.160.0`
- **Code:** `src/ops/opsWeb.ts` — `makeOpsWeb`

### A change waited for confirmation, but no Telegram message came
- **Check:** the service log has `ops.push` with `ok: false` and an error like "message is too long", for a change with a long summary.
- **Cause:** the headline and the detail were each cut at 3,500 characters, so together (with the link) they could pass Telegram's 4,096-character limit and the message was refused.
- **Fix:** upgrade. The whole message is kept under the limit: the link to confirm is never cut, the detail is shortened first.
- **Fixed in:** `v2.160.0`
- **Code:** `src/ops/push.ts` — `pushText`

### The Hatchabot agent never said how a change or build ended after it moved or was rebuilt
- **Check:** the change shows as done on the home screen, but the agent's conversation has no "[Hatchabot note …]" for it; the service log has `ops.note` with `ok: false` for that time, and the agent had just moved, been rebuilt or been made again.
- **Cause:** a note waiting behind another was sent to the agent as it was when the note was queued, on its old machine or container.
- **Fix:** upgrade. Each note looks up the Hatchabot agent when its turn comes; if it is not running then, the note is dropped (`ops.note_dropped`) and the outcome stays on the home screen.
- **Fixed in:** `v2.160.0`
- **Code:** `src/ops/notify.ts` — `createOpsNotifier`

### Asking the Hatchabot agent to "end the image trial" for itself moved it onto the fleet image
- **Check:** the Hatchabot agent's image (its agent page, Image row) is the fleet default after an `end_base_trial` confirm card that named it; Activity shows its image change and rebuild.
- **Cause:** the manager's own image pin is deliberate, and the chat tool refuses to end it — but the web chat and Telegram manager read agents through a client that dropped the "this is the Hatchabot agent" flag, so the refusal never fired.
- **Fix:** upgrade; pin the Hatchabot agent's image back on its agent page if it should stay where it was.
- **Fixed in:** `v2.160.0`
- **Code:** `src/mgmt/apiClient.ts` — `listAgents`; `src/mgmt/broker.ts` — `end_base_trial`

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

## Audit fixes in v2.158.2

### An archived agent's old bot still answers, or two agents answer the same bot
- **Check:** the old runtime is running although its stored state said stopped when Archive was requested; its runner could not answer the stop request.
- **Cause:** Archive previously accepted an unknown runtime status for a stopped record and released its bot.
- **Fix:** upgrade and confirm the old runtime is down before reusing the bot. Archive now refuses unknown status and keeps the lease for retry.
- **Fixed in:** `v2.158.2` (#29)
- **Code:** `src/orchestrator/archive.ts` — `archiveAgent`; `src/orchestrator/quiesce.ts` — `stopAndConfirm`

### A move copies a live volume or leaves the source running
- **Check:** the source container runs while its record says stopped; export or host move previously skipped stopping it.
- **Cause:** these snapshot paths trusted the stored state instead of checking the runtime.
- **Fix:** upgrade; snapshots now stop and observe the source first, refusing running or unknown status. Keep the source down when a destination may already run.
- **Fixed in:** `v2.158.2` (#30)
- **Code:** `src/orchestrator/transfer.ts` — `exportAgent`; `src/orchestrator/moveHost.ts` — `moveAgentToHost`

### Import fails but a destination container keeps running
- **Check:** the import failed after creating a runtime, and removing that runtime failed too. The destination now shows a held cleanup operation.
- **Cause:** ordinary import rollback previously discarded the identity even when runtime removal failed, letting the mover restart its source.
- **Fix:** restore connectivity to the destination's runner and choose Try again on its operation. Keep the source stopped until the destination confirms cleanup.
- **Fixed in:** `v2.158.2` (#26)
- **Code:** `src/orchestrator/transfer.ts` — `rollbackImport`, `resumeImport`; `src/orchestrator/migrate.ts` — `moveState`

### Removing Slack or Discord says it succeeded, but the old bot still answers
- **Check:** the runtime stop failed and the channel record disappeared; retrying removal returned not found.
- **Cause:** a failed stop prevented parking the bot but still deleted its credentials and channel record.
- **Fix:** upgrade. Removal now retains the connection and returns an error until it can confirm the runtime is stopped; retry when the runner answers.
- **Fixed in:** `v2.158.2` (#32)
- **Code:** `src/api/routes.ts` — `stopForBotHandover`

### An app recovery chooses the new release with the old settings
- **Check:** Go back failed while restoring scheduled tasks, then Use the new release succeeded with the previous configuration values.
- **Cause:** going back consumed the backup and overwrote the only candidate configuration before recovery had completed.
- **Fix:** upgrade; both configurations now survive a failed recovery choice. For a previously affected app, update it with the intended settings.
- **Fixed in:** `v2.158.2` (#27)
- **Code:** `src/orchestrator/appOperations.ts` — `configState`, `goBack`, `useNew`

### A removed or replaced app still has scheduled jobs
- **Check:** jobs named for the old app remain after removal, or both app names appear after replacement.
- **Cause:** an unreadable task list or failed task removal was treated as success.
- **Fix:** upgrade. Removal now checks a fresh task list, keeps the app record if cleanup is uncertain, and supports retry; a replacement cannot proceed while old jobs remain. Check older orphan jobs in the agent console.
- **Fixed in:** `v2.158.2` (#28)
- **Code:** `src/orchestrator/apps.ts` — `appJobs`, `removeTasks`

### A complete backup has no encryption key
- **Check:** the set has no usable `secret-key.env`, while its status says complete; the key was absent from the install's environment file.
- **Cause:** key capture was optional and ignored keys supplied only through the process environment; retention still ran.
- **Fix:** upgrade and run a fresh backup with the same key the server uses. A missing or empty key now makes the set incomplete and preserves older sets. Do not discard the original key or older keyed backups.
- **Fixed in:** `v2.158.2` (#31)
- **Code:** `scripts/backup-volumes.sh` — `finish`, `write_status`

### A local IPv6 address is accepted as another server
- **Check:** registering an IPv6 loopback, mapped loopback, or link-local URL reached the peer probe.
- **Cause:** the IPv4-oriented hostname check did not handle bracketed or mapped IPv6 literals.
- **Fix:** upgrade. Use the other machine's LAN or tailnet address; unsuitable literals and probe redirects are refused.
- **Fixed in:** `v2.158.2` (#33)
- **Code:** `src/api/peerAddress.ts` — `allowedPeerAddress`

### A mixed zram and disk-swap host grants compressed-swap allowances
- **Check:** the host has active zram and a plain swap file or partition while zswap is disabled.
- **Cause:** detecting any zram device qualified the whole host despite its uncompressed fallback.
- **Fix:** upgrade; the allowance is withheld and existing memory limits are reconciled. Disable plain disk swap or enable zswap if a compressed allowance is wanted.
- **Fixed in:** `v2.158.2` (#34)
- **Code:** `src/orchestrator/swap.ts` — `parseSwapProbe`, `limitsDrift`

### Typecheck reports TS7006 in the live-test register assertion
- **Check:** the errors name the filter and map callbacks in the parallel-test assertion.
- **Cause:** the assertion used the untyped JavaScript register rather than its typed view.
- **Fix:** upgrade the checkout; the assertion now uses the typed register.
- **Fixed in:** `v2.158.2` (#25)
- **Code:** `test/liveTests.test.ts`

### The use-case checker calls a named UI scenario a stale test reference
- **Check:** the documented UI script and scenario both exist, but the checker treats a comma-separated scenario name as a file.
- **Cause:** parsing dropped the script context after the first scenario.
- **Fix:** upgrade the checkout. Named references are now checked against their script, including each scenario.
- **Fixed in:** `v2.158.2` (#35)
- **Code:** `scripts/use-case-coverage.mjs`
