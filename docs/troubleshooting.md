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

### `hatchabot doctor`: "Control plane not answering at http://localhost:8080" (or at an old port), while the app works on another port or address
- **Check:** `.env` sets `PORT`, or `HATCHABOT_BIND` to one address, and the app answers there. Doctor was run with no `--url`, and either no `HATCHABOT_URL` was set, or the one in `~/.config/hatchabot/env` is this machine's (`http://127.0.0.1:<port>`, which `scripts/setup-host.sh` saves) with the port from before a change.
- **Cause:** with nothing chosen, doctor asked the CLI's default, `http://localhost:8080`, whatever the service's `.env` said. A saved local URL was asked as it was, so after a `PORT` or `HATCHABOT_BIND` change doctor probed the old address.
- **Fix:** upgrade: doctor asks the listener the `.env` describes (https with `HATCHABOT_TLS_CERT`, its `PORT`, its `HATCHABOT_BIND` address), as `scripts/restart.sh` does, unless `--url` is given or the saved URL is another machine's. A saved name (a full name, a `.local` name, a tailnet name) that resolves to this machine counts as this machine; one that does not resolve within 1.5 seconds is kept. The shell's own `PORT`, `HATCHABOT_BIND` or `HATCHABOT_TLS_CERT` play no part. Other commands still use the saved URL: change it in `~/.config/hatchabot/env` after a port change. On an older release: `hatchabot doctor --url http://<address>:<port>`.
- **Fixed in:** `v2.178.0`
- **Code:** `src/doctor.ts` — `gatherFacts`, `serviceUrl`, `servicePort`, `doctorTarget`, `addressesOf`; `src/cli.ts` — `'doctor'`

### `hatchabot doctor` reports another Docker's images and containers, or "Docker is installed but not reachable", while agents run
- **Check:** `.env` sets `DOCKER_HOST` (or `DOCKER_CONTEXT`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`), and your shell does not, or sets another; or the shell sets one the `.env` does not (`env | grep ^DOCKER_`).
- **Cause:** doctor ran `docker` with the shell's settings, so it asked the shell's daemon, not the one the service uses.
- **Fix:** upgrade: doctor's Docker checks use only the `.env`'s `DOCKER_*` settings, as the service does; the shell's are left out. On an older release, run doctor with the same `DOCKER_*` values as the `.env`, and unset any others.
- **Fixed in:** `v2.178.0`
- **Code:** `src/doctor.ts` — `serviceDockerEnv`, `gatherFacts`, `swapFacts`

### `hatchabot doctor` reports another database, backup folder, runtime image or set of containers than the service uses
- **Check:** your shell sets `HATCHABOT_DB`, `HATCHABOT_BACKUP_DIR`, `HATCHABOT_IMAGE`, `HATCHABOT_PREFIX`, `HATCHABOT_AGENT_NETWORK`, `HATCHABOT_AGENT_SWAP`, `HATCHABOT_PUBLIC_*` or `PORT` (`env | grep -E '^(HATCHABOT_|PORT=)'`) to something other than the `.env`.
- **Cause:** doctor read these from the shell first and the `.env` second. The service reads only its `.env`, so doctor checked a database, folder, image or port the service does not use.
- **Fix:** upgrade: doctor reads the service's settings from the `.env` alone. On an older release, unset those variables in the shell before running doctor.
- **Fixed in:** `v2.178.0`
- **Code:** `src/doctor.ts` — `gatherFacts`, `swapFacts`, `publicAccessFacts`

### `hatchabot doctor` never finishes, or stops with no report, on an install that serves HTTPS itself
- **Check:** `HATCHABOT_TLS_CERT` is set; `curl -vk https://localhost:<port>/` starts an answer and then the connection drops.
- **Cause:** the HTTPS probe waited for the answer's end and had no way out when the connection closed before it, nor any deadline for the whole answer.
- **Fix:** upgrade: the probe gives up after 10 seconds, or as soon as the answer is cut off, and the report says "Control plane not answering … (the answer was cut off)". Then look at the service: `journalctl --user -u hatchabot -n 50`.
- **Fixed in:** `v2.178.0`
- **Code:** `src/doctor.ts` — `probeControlPlane`

### `hatchabot doctor`: "Control plane not answering" with a certificate error, on an install that serves HTTPS on a LAN or tailnet address
- **Check:** `.env` sets `HATCHABOT_TLS_CERT`, and `HATCHABOT_BIND` to one address (a LAN or tailnet IP). The app answers in a browser there. Doctor's line names a certificate or a hostname/IP that does not match.
- **Cause:** doctor trusted the install's own certificate, but skipped the check of the name in it only for loopback. A certificate made for a host name does not name the bind address, so the probe of this machine's own listener failed.
- **Fix:** upgrade: doctor skips the name check for the address the `.env` binds to too, when that is an IP address (a bind that is a name is checked by name, as a certificate can hold it), and still checks that the certificate is the install's own. Each probe uses its own connection, so one that skipped the name check lets no later one through. On an older release: `hatchabot doctor --url https://<a name the certificate holds>:<port>`.
- **Fixed in:** `v2.178.0`
- **Code:** `src/doctor.ts` — `probeControlPlane`, `gatherFacts`

### Report a problem left a runner's address, a folder or a public IP address in the issue
- **Check:** the review panel or the filed issue shows `someone@laptop`, `ssh://…`, `/srv/…`, `/home/<someone else>/…` or a public IP address as written.
- **Cause:** the masking knew each host's label and not its address, needed a dot to read `user@host` as one, and masked only the home and backup folders and private IPs, though the panel said paths and addresses were masked.
- **Fix:** upgrade. Open reports are masked again as they leave, so a draft made earlier is covered. An issue already filed stays as it was: edit it on GitHub, or ask for it to be deleted. `docs/field-reports.md` lists what is masked and what is not.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/problemReport.ts` — `redactForPublic`, `endpointIdentity`; `src/api/routes.ts` — `reportRedaction`

### Report a problem left the rest of a path, a name or a password in the issue
- **Check:** the review panel or the filed issue shows the end of a path after a mask (`{path}Иванов/семья/x`, `~/<path> Family/taxes`, from a path with an accent, another script, a space or an apostrophe), `C:\Users\…` or `//nas/…`, `/etc/letsencrypt/live/<domain>/…`, part of a member's name, an account username in another case, `Connection closed by <machine> port 22`, an email with an accent or written `%40`, a phone number, or `--password x`, curl's `-u` with a password, `Cookie: …`, `/?claim=…` or `/join/…`.
- **Cause:** the path rules used ASCII `\w`, so they cut a path at its first unexpected character. Spaces were understood in one word only. System folders were kept by top level. The name, ssh and credential rules knew only some of the ways these are written.
- **Fix:** upgrade, then read the draft through. Open reports are masked again as they leave, so a draft made earlier is covered. An issue already filed stays as it was: edit it on GitHub, or ask for it to be deleted. Free text can never be fully safe: `docs/field-reports.md` lists what is not masked.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/problemReport.ts` — `redactForPublic`, `maskPaths`, `judgePath`, `maskAddress`, `maskName`, `maskSshWords`, `maskCredentialForms`, `maskPeople`; `src/api/routes.ts` — `reportRedaction`

### Report a problem left a private key's body, a folder after a port or an O'Brien in the issue
- **Check:** the review panel or the filed issue shows the lines of a `-----BEGIN …` block; a folder after a masked machine and a port (`https://{host}:8443/…`); a personal tail on a system folder (`/etc/ssl/certs/<domain>.pem`, `/proc/1/root/home/<someone>/…`, `/usr/share/<Family Name>/…`); `~/hatchabot/<Family>/…`, `/app/<Family>/…` or `~/.ssh/id_<name>`; `-v/srv/…`, `%APPDATA%\…` or `$PWD/…`; a member's name of 2-letter parts or with an apostrophe (`Bo Li`, `O'Brien`); a name after `%20`; or `pass=123456`, `DB_PASS=…`, `PASS: …` or `password 123456`.
- **Cause:** the key rule caught only runs of 40 characters, and `+` or `/` in base64 break a run. A port's last digit read as a letter, so no path could start after it. A system folder was kept with whatever followed it. The name and credential rules knew only some of the shapes.
- **Fix:** upgrade, then read the draft through. Open reports are masked again as they leave. An issue already filed stays as it was: edit it on GitHub, or ask for it to be deleted. A key that was in a filed issue is no longer secret: replace it. `docs/field-reports.md` lists what is masked and what is not.
- **Fixed in:** `v2.173.0`
- **Code:** `src/domain/redact.ts` — `maskKeyMaterial`; `src/orchestrator/problemReport.ts` — `judgePath`, `maskPaths`, `maskPeople`, `maskWords`, `maskCredentialForms`

### Report a problem left part of a password in JSON, a Ruby hash or a PuTTY key file in the issue
- **Check:** the review panel or the filed issue shows the rest of a value after `***` in a quoted field (`{"pass":"***"b…"}`, from a value with a `\"` in it), or a value kept whole after an escaped name (`\"password\":\"…` cut off, `\"token\":123456`), after mixed quoting (`\"pass":"…"`), after `:password =>` or `password =>`, after `TOKEN2=`, `API_KEY_2=` or `SECRET_KEY_BASE=`, after a camelCase, PascalCase or mixed-case name (`dbPass`, `DbPass`, `sshKey`, `Garden_Key`, `pw`), after a shell's `'…\'` before another setting, in curly quotes (also after an apostrophe inside them: `‘O’Brien…’`) or after a fullwidth colon, after a logfmt `\"` (`token="…\" …"`), in Docker's `"auth"`, after a lowercase `bearer`, the rest of `mysql -p'… …'`, a short `glpat-…` or `hf_…`, or the lines of a `.ppk` key file (`PuTTY-User-Key-File-…`, `Private-Lines:`), also with a prefix on each line.
- **Cause:** the quoted-field rule ended a value at the first quote it met, even an escaped one, needed a closing quote and quotes of the same kind, took a curly `’` that is also an apostrophe as the end, and did not know Ruby's `=>` after a bare name. A setting name had to end in the credential word, and a pass or key name needed a separator. A PuTTY key file has no `BEGIN` line, so the key rules never saw it whole.
- **Fix:** upgrade, then read the draft through. Open reports are masked again as they leave. An issue already filed stays as it was: edit it on GitHub, or ask for it to be deleted. A password or key that was in a filed issue is no longer secret: change it. `docs/field-reports.md` lists what is masked and what is not.
- **Fixed in:** `v2.174.0`
- **Code:** `src/domain/redact.ts` — `quotedFieldMasker`, `redactCredentialFields`, `isArrowCode`, `maskKeyMaterial`, `maskPuttyKeys`; `src/orchestrator/problemReport.ts` — `maskCredentialForms`, `maskQuotedPassAndKey`, `maskDockerAuth`

### Report a problem turned a log line into {path}, or masked everyday words as names
- **Check:** a title or log line with a path in it reads `{path}` alone with no second path or file named later on the line, or the sentence after a path is gone. Or ordinary words show as masks: `it {user} fail` for a user named will, `the {name} bot` for a member named Telegram User, `{name}-10-05` for a member named Alex 2026, `github.{name}` for a member whose name is an email address. Or `tcp` shows as `{host}` after a runner was added at `tcp://:2375`; or `openssl-1.1.1-8.el8.noarch` or `config.local` as `{host}`, a list of numbers as `{phone}`, or `-p3306:3306` as `-p***`.
- **Cause:** after a space, a path took capitalized words with no limit, and plain words up to one that looked like a file. Usernames and the parts of a member's free-text name were masked in any case, whatever the word. `endpointIdentity` read a scheme as the host when an address had none.
- **Fix:** upgrade: with nothing later on the line that looks like a path or a file, the path stops at a log word, a label or a common word in lowercase. Everyday words alone go only as written, and these forms stay. A username that is a very common word (will, max) is masked in lowercase only where the line says it is a user, so read the draft for one written in passing. A sentence that names a second path is still masked with the first, on purpose: edit it back if the words matter.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/problemReport.ts` — `afterSpace`, `maskUsers`, `maskPeople`, `maskName`, `endpointIdentity`

### Report a problem left a folder's name, a whole member's name or a username in the issue after a log word or an everyday word
- **Check:** the review panel or the filed issue shows the rest of a folder after `{path}` (`{path} Denied Claims/x.pdf`, `~/{path} to Paris/IMG_0001.jpg`, `PWD=*** Family/taxes`), a member's name in lowercase (`will page`, `rose brown`, `alma rocky`), a username in `Failed password for bob from …`, `sudo: bob :`, `-rw------- 1 bob bob`, `chown bob:bob` or `USER=WILL`, a folder after `http://{name}:8080/`, a path in a query (`/v1/files?path=/srv/…`), a personal tail on a shared or library folder (`/usr/share/nginx/html/Family/…`, `/usr/lib/smith/JaneRoe.pdf`), or the lines of a cut-off key in a journal or a quote.
- **Cause:** masking was made less eager to save words, and that left these: a log word or a common word ended a path even with a `/` later on the line, a name whose parts were all on the everyday list went only as written, and every username on that list only where the line said user. `PWD=` was read as a password, so its mask stopped at a space and no path was left to find.
- **Fix:** upgrade, then read the draft through. Open reports are masked again as they leave. An issue already filed stays as it was: edit it on GitHub, or ask for it to be deleted. The rule now is that a leak is worse than a lost word: a later word with a `/` or a file ending takes everything before it with the path, a whole name goes in any case, and a sentence can lose words to a mask. `docs/field-reports.md` lists what is masked and what is not.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/problemReport.ts` — `afterSpace`, `maskPeople`, `isDefaultName`, `maskUsers`, `systemKeep`, `maskQueryValue`, `maskSshWords`; `src/domain/redact.ts` — `isShellFolder`, `keyRunEnd`, `isKeyLine`

### Report a problem masked plain words: "{user} rebuild on {user} fails", or a stack trace path as {path}
- **Check:** words like `docker`, `ubuntu`, `git`, `server` or `runner` show as `{user}` or `{host}` in a report, and the runner's address has that word as its user or host. An edit does not bring them back. Or `/app/dist/index.js`, `/tmp/a/b`, `/home/node/.openclaw/x`, `app.get('/join/:code')`, or a package or image with its version or digest after an @, show as a mask.
- **Cause:** a runner's user and host label were masked as words in any case from 6 letters, with only `root` and `admin` spared. The path and address rules took container paths, route patterns and an @ before a version for private ones.
- **Fix:** upgrade: generic words are never treated as names, and these forms stay. Check what remains is what you meant to send.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/problemReport.ts` — `maskWords`, `judgePath`, `maskAddress`

### Report a problem answers 500 on every draft after a runner was added
- **Check:** `GET`, `POST` or `PATCH` on `/v1/problem-reports` answers 500 with `URI malformed`, and a runner's address has a bad `%` in its user: `tcp://a%ZZ@host:2376`.
- **Cause:** `endpointIdentity` decoded the user outside its `try`, and `reportRedaction` reads every runner row.
- **Fix:** upgrade. Before that, remove the row or correct the address.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/problemReport.ts` — `endpointIdentity`; `src/api/routes.ts` — `reportRedaction`

### The server stops answering for seconds while a report is saved or opened
- **Check:** other requests stall while a long report draft is saved or opened, and the draft has a very long run like `a.a.a.a…`, a long dotted name or a dump of hyphenated text.
- **Cause:** the address rules started again at every `.` of a run, so masking took about 17 s on 60,000 characters, on the server's one thread. Each `GET` of that draft masked it again.
- **Fix:** upgrade. Masking is now one pass over the text.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/problemReport.ts` — `redactForPublic`, `maskAddress`, `maskName`

### A report's text has gaps: "open failed" where a path was
- **Check:** a filed issue reads "open failed for at on", and in the review panel or the saved file the same text has `<path>`, `<email>` or `<ip>`.
- **Cause:** outside a code fence, GitHub's markdown takes `<path>` for an HTML tag and drops it. Nothing private went out, but the report lost its meaning.
- **Fix:** upgrade: the masks are `{path}`, `{email}` and so on, and an open draft moves to them as it leaves.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/problemReport.ts` — `redactForPublic`

### Rootless Docker: a restore says the archive "could not be read", or a set is incomplete because "docker wrote the archive as uid N"
- **Check:** `ls -ln <backup-dir>/<date>/` shows `.tgz` files owned by a large uid (a sub-uid such as 100999) with mode 600, and `cat` on one says "Permission denied". `hatchabot doctor` says rootless. From the fix on, a run that hits this names the volume, says the uid, and the set reads incomplete.
- **Cause:** the backup ran the archive step as root in a container and chowned the file to this user's uid. Under a rootless daemon, root in the container already is this user, and that uid inside maps to a sub-uid, so the archive became unreadable while the run still counted it.
- **Fix:** upgrade: under a rootless daemon there is no chown now, and an archive this user cannot read makes the set incomplete, so older sets are not pruned. To repair an older set, from the same user: `docker run --rm --user root -v <backup-dir>/<date>:/d hatchabot-runtime:latest chown -R 0:0 /d`. A daemon remapped another way (`userns-remap`) still shows the message: it has no such repair from this script.
- **Fixed in:** `v2.173.0`
- **Code:** `scripts/backup-volumes.sh` — `ROOTLESS`, `hand_over`

### A restored database is not the backup: it has newer rows, or a mix, after copying `hatchabot.sqlite` over the old one
- **Check:** before the first start after the restore, `ls data/` shows `hatchabot.sqlite-wal` beside the file you copied in. After it, the app shows changes from after the backup's date.
- **Cause:** the service stopped uncleanly (a crash, a kill, a stop that timed out, a full disk) and left a write-ahead file. Copying only the main file leaves it there, and SQLite replays it onto the restored file with no message. `integrity_check` still says ok.
- **Fix:** stop the service, then `rm -f data/hatchabot.sqlite-wal data/hatchabot.sqlite-shm` and copy the set's `hatchabot.sqlite` over again (README, "Restoring from backup"). The older README steps left this out.
- **Fixed in:** `v2.173.0`
- **Code:** `README.md` — "Restoring from backup"

### `HATCHABOT_BACKUP_KEEP_DAYS`: every nightly set is incomplete with a `find` error, or sets vanish after a day
- **Check:** the setting in `.env` is not a plain whole number above 0: `14d` gave "invalid argument … to `-mtime'" at the end of each run, and nothing was pruned; `0` removed each set after about a day apart from each agent's newest copy, while Settings → Backups said 14.
- **Cause:** the panel read the setting with a check of its own, and the script used it as written.
- **Fix:** upgrade, or set a whole number of days. Now both read anything else as 14 and the run says so. There is no "keep forever" value.
- **Fixed in:** `v2.173.0`
- **Code:** `scripts/backup-volumes.sh` — `KEEP_DAYS`; `src/orchestrator/backups.ts` — `keepDays`

### A morning's complete backup reads incomplete after "Back up now" was cut off, and today's set drops from an agent's restore choices
- **Check:** the day's `backup-status.json` says `incomplete` with a short `captured` list, while the set folder still holds every `<volume>.tgz`, and the guided restore offers yesterday for agents the second run did not reach.
- **Cause:** each run wrote its own record over the day's, listing only what it captured itself, though the earlier run's archives stayed whole.
- **Fix:** upgrade, and the next run of the day carries over what the earlier run wrote whole. Yesterday's set is still good meanwhile, and a `<volume>.tgz` in a set is always whole: a run that ends well marks the set complete again.
- **Fixed in:** `v2.173.0`
- **Code:** `scripts/backup-volumes.sh` — `earlier_captured`, `add_captured`


### An agent's Recovery row offers yesterday's backup, though a run this morning took it whole and a later run failed on it
- **Check:** today's `backup-status.json` names the agent's volume in both `captured` and `failedVolumes`, and its `<volume>.tgz` is in the set.
- **Cause:** a later run of the same day that fails on a volume keeps the earlier run's whole archive (one is replaced only by renaming a whole one over it) and names the volume in both lists. Before v2.178.0 readiness and the guided restore read "failed" first and offered an older day.
- **Fix:** upgrade. The morning's archive was there all along, and a run that ends well marks the set complete again.
- **Fixed in:** `v2.178.0`
- **Code:** `src/orchestrator/recoveryReadiness.ts` — `usableFor`

### `hatchabot upgrade vX.Y.Z` failed, and since then the machine stays put: "Pinned to" a release it never got
- **Check:** `cat <install>/data/channel` names a version that `hatchabot doctor` does not show as running; the channel timer's log is quiet; with public access on, the automatic-upgrades safeguard is off.
- **Cause:** a version named by hand was written as a pin before anything checked it: a mistyped version on a bundle install, a tree with local changes, or a busy upgrade lock left the pin behind. A pinned upgrade SIGKILLed or cut by a power failure could also leave one: the timer repaired the swap, could not get the release, and then found nothing more to do.
- **Fix:** `hatchabot upgrade stable` follows the channel again. Now a version with no release is refused with exit 2, and a pin is written only once the release is confirmed, and taken back if the upgrade does not finish. What the pin replaced is noted first in `~/.local/state/hatchabot/upgrade-*.pin`: after a kill, the next tick puts the earlier release back and tries the pinned one once. If it does not end up installed, the earlier channel comes back and the timer follows it; if it does, the pin stays. If what it replaced was a pin you made earlier, that pin comes back and stays, however many more tries the repair takes. A pin from a run of an older `upgrade.sh`, with no note and no `pins-recorded` line in its `.from` or `.swapping`, just comes off.
- **Fixed in:** `v2.173.0`
- **Code:** `scripts/upgrade.sh` — `pin_named`, `unpin`, `PIN_RECORD`, `PINS_RECORDED`; `scripts/follow-channel.sh` — `repair_due`

### First install: "unpacked" with no version, then setup fails, and a re-run says the folder "is not a Hatchabot install"
- **Check:** the output has an `mv` error before `unpacked: Hatchabot with its own Node  — nothing to compile`; the install folder is partial or holds only `data/`.
- **Cause:** a failed final move of the bundle (a full disk on a copy across filesystems, or no permission) was not checked, and the installer went on to set up.
- **Fix:** remove the partial folder (nothing is in it yet), free some space, then re-run the installer. It now moves the bundle in under a name beside the folder and renames it, so the folder is whole or absent, and stops with the reason.
- **Fixed in:** `v2.173.0`
- **Code:** `install.sh` — `install_bundle`

### The installer says the install folder "is not a Hatchabot install — move it aside", but it holds your `.env` and `data/`
- **Check:** `ls -a <install>` shows `.swapping` and `.prev-release`, and there is no `BUNDLE.json`.
- **Cause:** a bundle upgrade was killed in the swap, in the moment `BUNDLE.json` was aside, and the installer looked only for `BUNDLE.json`.
- **Fix:** do not move it aside. `hatchabot upgrade`, or the channel timer's next tick, or now the installer itself puts the previous release back and goes on.
- **Fixed in:** `v2.173.0`
- **Code:** `install.sh` — `MODE`; `scripts/upgrade.sh` — `restore_prev`

### Shared host: an upgrade fetched the runtime image, but the tenant's daemon still has the old one
- **Check:** `.env` sets `DOCKER_HOST`; `DOCKER_HOST=<that value> docker image inspect hatchabot-runtime:latest --format '{{ index .Config.Labels "org.agentclaw.openclaw-version" }}'` shows the older OpenClaw.
- **Cause:** `upgrade.sh` and the channel timer do not read `.env`, so the image step used the default daemon.
- **Fix:** upgrade. Until then, Settings → Advanced → Runtime images, or `DOCKER_HOST=<that value> ./scripts/build-runtime-image.sh`.
- **Fixed in:** `v2.173.0`
- **Code:** `scripts/upgrade.sh` — `DOCKER_HOST`

### A full disk reads as "No bundle for vX yet", or the installer goes on to "using the native install instead"
- **Check:** `df -h <install folder>` and `df -h /tmp` show little free. The upgrade's log repeats "No bundle for…", or a first install has tar's "No space left on device" just before it asks for git and build tools.
- **Cause:** any download failure read as no bundle yet, and any unpack failure on a first install as a bundle that cannot be used.
- **Fix:** free about 1 GB (`docker system prune`, old backup sets), then try again. Each now says the disk is full, with the space free, and exits without going on to a heavier install. A folder beside the install that this user cannot write is said as that instead: fix its permissions.
- **Fixed in:** `v2.173.0`
- **Code:** `scripts/upgrade.sh` — `disk_full`, `no_stage`; `install.sh` — `install_bundle`, `bundle_room`

### A runner stays at "Permission denied" after pasting step 2, and pasting again does nothing
- **Check:** on the runner, `grep -c '' ~/.ssh/authorized_keys` is lower than you expect, and `grep 'agentclaw control-plane' ~/.ssh/authorized_keys` shows the key at the end of a line that starts with another key.
- **Cause:** the file did not end in a newline, so the snippet's `echo >>` put the key on the same line, where sshd read it as the old key's comment. A second paste found the text and added nothing.
- **Fix:** copy the snippet from a release with the fix and paste it again: it puts the key on its own line and splits off a key glued onto a complete earlier key line, keeping both. A line that has the key any other way (with `from=` or `command=` options, a longer comment, commented out) is the owner's: it stays as it is, nothing is added beside it, and the paste says `this key is already in`. If that line is why the key is refused, edit it by hand. If it says `could not write`, the file's whole text is beside it in `authorized_keys.agentclaw-new`: compare the two, keep the whole one, delete the copy and paste again. If it says `could not read`, the file's permissions keep this user out (sshd is kept out too): nothing was written and its mode was left alone, so `chmod 600 ~/.ssh/authorized_keys` and paste again.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/runnerSetup.ts` — `runnerSetupSnippet`

### Browsers and memory search stopped for agents on a runner after removing a spare row for it
- **Check:** Settings → Hosts lists, or listed, two rows for one machine (the same address twice, or a hostname and a tailnet address), and agents on the row that stayed lost their memory search or browser when the other row was removed.
- **Cause:** a row's removal checked only its own agents, then removed everything of Hatchabot's on that daemon, whose names are per machine rather than per row.
- **Fix:** rebuild the agents that lost them, which brings the memory search service back. Now the same address is refused, another address for the same daemon is warned about when it is added, and removing a row leaves the machine alone while another row points at it. Rows told apart only by a daemon's ID may be cloned machines that share one, so that removal says what to remove by hand if it really is another machine; the same address says nothing.
- **Fixed in:** `v2.173.0`
- **Code:** `src/api/routes.ts` — `/v1/hosts`, `/v1/hosts/:id`, `rowsOnSameDaemon`

### A runner added by an IPv6 address stays at "Permission denied"
- **Check:** its row's address is `ssh://…@[…]`. `grep -c agentclaw-runner ~/.ssh/config` on this machine has no block for it.
- **Cause:** the managed ssh block is written only for a hostname or IPv4 address, and such an address was saved without one, so ssh offered only the default keys.
- **Fix:** remove the row and add the machine by hostname or IPv4 address (a tailnet machine has both). Such an address is now refused when added.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/runnerSetup.ts` — `parseSshEndpoint`; `src/api/routes.ts` — `/v1/hosts`

### "I upgraded but nothing changed"
- **Check:** `hatchabot doctor` prints "Checkout has local changes (…) — the installer refuses to upgrade over them", or "Running vX, but the stable channel names vY".
- **Cause:** a git-checkout install will not move over local edits, and an upgrade that was refused leaves the old release running.
- **Fix:** `git -C <install dir> stash` (or commit the changes), then `hatchabot upgrade`. A bundle install has no checkout and never shows this.
- **Fixed in:** —
- **Code:** `src/doctor.ts` — `checkoutFacts`

### Doctor said "hatchabot upgrade vX (keeps the channel)", and after running it upgrades stopped and the public address answers 503
- **Check:** `cat <install>/data/channel` prints a version rather than a channel, and `hatchabot doctor` says "Pinned to vX" or that the automatic-upgrades safeguard is off.
- **Cause:** a version named to `hatchabot upgrade` is a pin: the channel timer leaves the machine alone until a channel is named again. Before the fix, doctor compared the running release with the newest tag the machine had fetched, promoted or not, and offered that version with wording that said the channel stayed.
- **Fix:** `hatchabot upgrade stable` follows the channel again, and the safeguard passes on its next check. Doctor now compares with what the install's channel names and offers plain `hatchabot upgrade`.
- **Fixed in:** `v2.173.0`
- **Code:** `src/doctor.ts` — `checkoutFacts`, `doctorReport`

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

### Two upgrades ran at about the same time, and the install ended on the older release
- **Check:** the channel timer's log (`journalctl --user -u hatchabot-follow-channel`) or a hand-run upgrade shows `Upgrading vA → vB` where vA is older than the release another upgrade had just installed (for example `hatchabot upgrade latest` finished a moment before), and the install is now on vB.
- **Cause:** upgrade.sh read the installed release before it took the upgrade lock. A run that read it just before another upgrade finished went on from the old release, and its channel's older target took the machine backwards, though a channel never should.
- **Fix:** upgrade, then `hatchabot upgrade <the release or channel you want>` once. The installed release is now read under the lock, so the second run sees the newer release and leaves it.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/upgrade.sh` — `take_lock`, `vernewer`

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

### After re-running setup, new agents still run an old OpenClaw, and setup said "Runtime image already present"
- **Check:** `docker image inspect hatchabot-runtime:latest --format '{{ index .Config.Labels "org.agentclaw.openclaw-version" }}'` prints nothing (or `<no value>`): an old or hand-built image with no version label.
- **Cause:** setup compared versions only when the image had a version label; an unlabelled `:latest` was kept as it was.
- **Fix:** `./scripts/build-runtime-image.sh` in the install folder, then rebuild agents when convenient (memory is kept). Setup now counts an image with no version label as older than the release's default and fetches the default.
- **Fixed in:** `v2.169.0`
- **Code:** `scripts/setup-host.sh` — `HAVE`

### A shared-host tenant (its `.env` sets `DOCKER_HOST`): setup said "Runtime image already present", but agents cannot start for want of the image
- **Check:** `grep ^DOCKER_HOST= <install>/.env` names the tenant's daemon, and `DOCKER_HOST=<that value> docker image ls hatchabot-runtime` is empty, while plain `docker image ls hatchabot-runtime` lists it.
- **Cause:** setup wrote `DOCKER_HOST` into `.env` for the service but looked for (and would have fetched) the runtime image on the daemon of the shell it ran in, which already had one.
- **Fix:** in the install folder, `DOCKER_HOST=<that value> ./scripts/build-runtime-image.sh`. From v2.168.0 setup uses the `DOCKER_HOST` in `.env` (the last such line) for the image, and stops if that daemon does not answer.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/setup-host.sh` — `DOCKER_HOST`

### uninstall.sh says "The service runs from …, but this script is in …"
- **Check:** `grep WorkingDirectory ~/.config/systemd/user/hatchabot.service` names a different folder from the one you ran it in.
- **Cause:** the service belongs to another checkout. Uninstall now refuses rather than remove that other install's service and agents (before v2.153.0 it purged it).
- **Fix:** run `<that folder>/scripts/uninstall.sh`, or add `--installed`. To drop only the clone, `rm -rf` it.
- **Fixed in:** `v2.153.0`
- **Code:** `scripts/uninstall.sh` — `--installed`

### `uninstall.sh --installed --backups` removed the backups of the clone it was run from, and left the service install's
- **Check:** the service install's `.env` sets `HATCHABOT_BACKUP_DIR` to a relative folder (`backups`, not `/home/…/backups`).
- **Cause:** before v2.168.0 uninstall read a relative backup folder from the folder it was started in, not from the install it was removing; the server reads it from its own install folder.
- **Fix:** upgrade. Before that, give `HATCHABOT_BACKUP_DIR` as a full path, or run the service install's own `scripts/uninstall.sh` rather than `--installed`.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/uninstall.sh` — `BACKUP_DIR`

### `uninstall.sh --purge` on an install from before the rename says everything is gone, but its agents still run
- **Check:** `.env` sets `AGENTCLAW_DB` (or the database is `data/agentclaw.sqlite`), and `docker ps` still lists the agents.
- **Cause:** before v2.168.0 uninstall read only the `HATCHABOT_*` names and the new default database, so it found no agents, removed none, and deleted the `.env` that named the real database.
- **Fix:** upgrade, then run uninstall again. If the `.env` is already gone, put back `AGENTCLAW_DB=<the database>` in it first.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/uninstall.sh` — `AGENTCLAW_`; `src/envCompat.ts` — `applyLegacyEnv`

### `uninstall.sh --purge` says "Docker is not answering … Refusing to --purge", or "Docker stopped answering part-way"
- **Check:** `docker info` fails (the daemon is stopped, or this session is not in the `docker` group yet).
- **Cause:** a purge deletes the database and `.env`, the only record of which containers and volumes are this install's. Before v2.168.0 a Docker that did not answer read as "no agents": the purge deleted both, said everything was gone, and left the agents running.
- **Fix:** start Docker (or log in again for the group) and run uninstall again; nothing was removed. If Docker and its volumes are gone from the machine for good, delete the database and `.env` by hand.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/uninstall.sh` — `DOCKER_OK`, `DOCKER_LOST`

### `uninstall.sh --purge` deleted other files in the folder that held a moved database
- **Check:** `.env` sets `HATCHABOT_DB` to a database in a shared folder whose path has `hatchabot-data` in it somewhere above (for example `…/hatchabot-data-old/shared/registry.sqlite`).
- **Cause:** before v2.168.0 uninstall took a whole folder as Hatchabot's own when `hatchabot-data` appeared anywhere in its path, and removed it with everything in it. Now only the install's `data/` or a folder named exactly `hatchabot-data` goes whole; anywhere else only the database files go.
- **Fix:** upgrade before purging an install whose database lives in a shared folder. Files already removed come back only from your own backups of that folder.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/uninstall.sh` — `*/hatchabot-data`

### `uninstall.sh` says "could NOT stop hatchabot.service … Stopping … failed, so nothing else was touched"
- **Check:** `systemctl --user status hatchabot` (on a Mac, `launchctl list com.hatchabot.control-plane`) shows it still running; `journalctl --user -u hatchabot -n 30` says why the stop failed.
- **Cause:** uninstall removes the database and `.env` only once the service is seen stopped. Before v2.168.0 a failed stop was ignored: the unit, the database and the key went while the service still ran on them, and it said Hatchabot was no longer running.
- **Fix:** stop it (`systemctl --user stop hatchabot`; after a lost user session, log in again), then run uninstall again.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/uninstall.sh` — `STILL_RUNNING`

### After uninstalling one clone, the hbt or hatchabot command is gone for a second install on the same machine
- **Check:** `readlink -f "$(command -v hatchabot)"` names a folder other than the one you uninstalled, or `command -v hbt` finds nothing.
- **Cause:** before v2.168.0 uninstall removed any `hbt` link that led to a Hatchabot CLI, and always ran `npm unlink -g hatchabot`, whichever install they ran. Now it removes only the ones that lead to the install it removes, and says when it keeps one that runs a different install.
- **Fix:** run `./scripts/link-cli.sh` in the install that should own the commands.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/uninstall.sh` — `HBT`; `scripts/link-cli.sh`

### After `uninstall.sh --purge`, an agent on a runner is still running there (or: uninstall.sh says "These agents run on another machine (a runner)")
- **Check:** on the runner (the machine named in the app's Hosts), `docker ps -a` lists the agent's container and its `-vol` volume, while this machine's install is gone.
- **Cause:** uninstall.sh asks only this machine's Docker. An agent on a runner lives on that machine's daemon, so a purge never stopped it, then deleted the only record of it and the key to its data, and said every agent was gone.
- **Fix:** before purging, delete such agents in the app (or move them to this machine). From v2.168.0 `--purge` refuses while the database names agents on a runner, and lists them; `--purge --forget-runners` goes on and leaves them running there. One already forgotten: on the runner, `docker rm -f <container>` and `docker volume rm <container>-vol`.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/uninstall.sh` — `runner_agents`, `--forget-runners`

### Purge keeps refusing over agents on a runner that were already deleted ("These agents run on another machine (a runner)")
- **Check:** the agents it names are gone from the app (deleted there); `sqlite3 data/hatchabot.sqlite "SELECT name, state FROM agents"` shows them `DELETED`.
- **Cause:** before v2.171.0 the runner check counted every agent row on a runner, and the app keeps a deleted agent's row as history. Deleting the last agent on a runner left purge blocked for good, asking to delete agents that were already deleted. Now a `DELETED` row does not count; any other state still does.
- **Fix:** upgrade, then purge again. Before that, `--purge --forget-runners` goes on (check the runner with `docker ps -a` first: nothing of a deleted agent should be there).
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/uninstall.sh` — `runner_agents`

### Uninstall says "none running" while agents made before the rename still run, and a purge leaves their containers and volumes
- **Check:** `docker ps -a` lists `agentclaw-<12 characters>` containers and `docker volume ls` their `agentclaw-vol-…` volumes after an uninstall; the database's `runtime_ref` for them is `docker://` and a bare id, with no `hatchabot-` or `agentclaw-` in front.
- **Cause:** before v2.171.0 uninstall looked for a container named the bare id and a volume `<id>-vol`, while the runtime names such an agent `agentclaw-<short>` and `agentclaw-vol-<short>` (`dockerNames`). It found none, left them running, and a purge then deleted the database and key that mapped them.
- **Fix:** upgrade, then run uninstall again. Already purged: `docker rm -f agentclaw-<short>` and `docker volume rm agentclaw-vol-<short>` for each one `docker ps -a` lists (their data cannot be read without the deleted key).
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/uninstall.sh` — `agent_names`, `VOL_NAMES`; `src/providers/dockerNames.ts` — `dockerNames`

### Uninstall said Hatchabot is no longer running, but an agent's container is still up
- **Check:** `docker ps` still lists the agent; `docker stop <name>` fails with an error from the daemon (permission denied by a security profile, a daemon that is stuck).
- **Cause:** before v2.171.0 uninstall ignored a failed `docker stop`: it said the containers were stopped, that Hatchabot was no longer running, and exited 0. Now it names the agents still running, says Docker would not stop them, and exits 1; a `--purge` that cannot remove one keeps the database and `.env`, the map to it.
- **Fix:** see why with `docker inspect <name>` and the Docker daemon's log (`journalctl -u docker`), then `docker stop <name>`. The service and its units are already removed; nothing else needs redoing.
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/uninstall.sh` — `running_agents`, `AGENTS_UP`

### After uninstall, an agent's browser container (`…-browser`) is still running
- **Check:** `docker ps --filter label=hatchabot.role=browser` lists one whose `hatchabot.browser-of` label is one of the uninstalled install's agents.
- **Cause:** before v2.171.0 uninstall removed the agents' doormen and the memory search service but never looked for the browsers the agents' browser option starts, so they stayed up in the stopped agents' network. Now they are removed with the doormen, before the agents stop.
- **Fix:** `docker rm -f <name>-browser` for each one. It holds nothing: the agent's next start makes it again.
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/uninstall.sh` — `service_containers`; `src/providers/localDockerProvider.ts` — `ensureBrowser`

### The channel timer says a release "will not be retried", or the service restarts every ten minutes
- **Check:** `journalctl --user -u hatchabot-follow-channel` (or `-u hatchabot-follow-latest`); `cat ~/.local/state/hatchabot/follow-channel-failed* ~/.local/state/hatchabot/follow-channel-tries*` (from v2.168.0 each install's records end in a number of its own).
- **Cause:** before v2.153.0 a network failure counted as "release failed", so a release was set aside without being tried. An install that always failed rolled back and restarted the service on every tick.
- **Fix:** upgrade by hand (`hatchabot upgrade stable`), then `rm ~/.local/state/hatchabot/follow-channel-failed*`. From v2.153.0 a failing install is retried with growing waits, set aside after 8 failures in a row, and never restarts the service.
- **Fixed in:** `v2.153.0`
- **Code:** `scripts/follow-channel.sh` — `MAX_TRIES`; `scripts/upgrade.sh` — `rollback`


### The channel timer set a release aside after the disk had been full for a while
- **Check:** `cat ~/.local/state/hatchabot/follow-channel-failed*` names the release (on the machine that follows the newest tag, `follow-latest-failed`); `journalctl --user -u hatchabot-follow-channel` (or `-u hatchabot-follow-latest`) shows "is full" or "(a full disk?)" lines before "did not complete 8 times in a row".
- **Cause:** before v2.178.0 a full disk ended `upgrade.sh` with exit 3, the same as an install that failed, and the eighth in a row set the release aside until the channel's next one. Now a full disk, or a folder it cannot write, is exit 5: the timer waits longer each time as before, but never counts it against the release. The wait doubles by the release's own failed tries (a day at most); tries that only the disk failed wait an hour at most, however long the disk stays full (twelfth review: before, nine of them made the wait a day, and the release, once there was room, waited that day for its first try of its own). That covers a bundle's download, unpacking and swap, and on a git install the checkout and `npm ci` (their error says "No space left on device" or a disk quota, or the disk has under 64 MB left), the upgrade's own records (the pin, the channel it follows, the checkout's record, the lock and its folder) and the temporary copy of the script. A lock it could not write its name in is removed, where it was left behind and the next hour of runs said "Another upgrade … is running". Only those exit 5: another command that exits 5 under the script is exit 3, and so is "ENOSPC: System limit for number of file watchers reached", which is the inotify watcher limit and not the disk. `deploy-release.sh` and the follow-latest timer do the same for a production checkout. A timer that cannot write its own record of the try on the full disk says "Could not record this try" and keeps it in the user's runtime folder (`$XDG_RUNTIME_DIR`, only when it is a folder of the user's own, and never through a symlink) until it can, so it still waits; with no runtime folder it keeps nothing and says the next tick tries again (never in a shared `/tmp`, where another user could plant the file). Before, it stopped there with no word and tried again every ten minutes. The record keeps the three fields the timers of releases before read (`<release> <failures> <time>`); how many of those failures were the disk's is kept beside it, in the same name with `.disk` (tenth review: a fourth field in the record made an older timer, after a rollback, start its count again). The checkout is asked in English (`LC_ALL=C`), and the install for its messages only (`LC_MESSAGES=C`, the user's `LC_ALL` moved to `LANG`), so a build keeps the user's locale (fourteenth review: `LC_ALL=C` over the whole install set every category); either way a full disk is read as one in any language, and their errors are kept in the state folder, not `$TMPDIR`, which may be the same full disk, and the last 4 KB in memory too, for when that file cannot be written. Where the state folder takes no new file, the errors go to `$TMPDIR`, so the path a permission names is still said (twelfth review: it said "could not write what it needed"). A step's words that say the disk ("No space left on device", ENOSPC, a disk quota, or a write that came up short with no reason given: "unable to write", "write error", "short write", as git's "fatal: unable to write new index file") are the disk; so is any failure when the disk has under 64 MB left, whatever it said. Words that say a permission or a read-only disk on writing ("Permission denied", EACCES, "Read-only file system", EROFS from opening, making, renaming, writing, copying or moving: npm's cache folder it may not write, a move onto a read-only disk) are the machine's too, exit 5, when the path they name is one of this install's own places (the install, its state folder, npm's and node-gyp's caches in the home folder, `$TMPDIR`); a write refused anywhere else, such as a global install into `/usr/local`, is the release's own, exit 3 (fourteenth review), and the run names the path they give: "This user could not write … (above: no permission there, or a read-only disk)" (tenth review; before, they were exit 3 and counted against the release). An ssh key a server turned away ("Permission denied (publickey)") is not one of them, nor a file the step could not run (a script without its execute bit, such as the release's `ensure-deps.sh`: bash's exit 126, npm's "code 126", "sh: 1: …: Permission denied", Node's "spawn … EACCES"), which is the release's own, exit 3 (eleventh review). Bash's own "line N: FILE: Permission denied", which it says both for a file it could not run and for a redirection it could not write, is judged by FILE: a regular file in the release's tree without its execute bit, that this user may write, is the release's (3); any other (a file outside the release, a record of the install's made read-only, or a file of its own on a disk mounted `noexec`) is the machine's, 5 (twelfth review). Words of its own (npm's lockfile mismatch) with more room than that are the step's own failure, exit 3. Only the step's last lines are judged (the last 20, 2 KB at most), which hold the error that ended it, and each line on its own (twelfth review: "spawn" on one line and EACCES on a later one read together as a file it could not run, so npm's "EACCES: permission denied, mkdir …" after gyp's "spawn make" was exit 3): before the eleventh review an early warning decided, such as gyp's "WARN EACCES" for its dev dir before a compile error, which then read as a permission (exit 5). Those last lines are kept in memory as the step runs, and the log is read only when there is nothing there: a log that stopped taking lines part-way, on the disk that filled, held only the step's earlier warnings. Each step is judged by its own words only: a warning an earlier step printed (the checkout's, say) no longer decides an install that failed after it. The lock's folder and the checkout's record, written before anything moves, are judged as the channel files are: something in the way is named (exit 2); any other failure there (no room, no permission, a read-only disk) is the machine's, 5, never the release's, as these are the install's own files. So is the lock itself: "Could not take the upgrade lock …" shows what mkdir said and names the folder to check, and is 5. Another upgrade holding the lock (exit 4) is routine: the channel timer's tick ends there quietly (0) and counts nothing, with the release found or offline, and so does the follow-latest timer's, its repair of a cut-off deploy too (tenth review); a full disk (5) still ends the tick as failed, so the unit shows it, but is never counted against the release. A relative `HATCHABOT_PROD_DIR` (run from another folder) is made absolute after the deploy's `cd`: before, the disk was looked for at a folder that was not there, and a nearly full one read as the release's failure (tenth review). `deploy-release.sh` says 5 only to a caller that sets `HATCHABOT_FOLLOW_KNOWS_5=1`, as `follow-latest.sh` does from v2.178.0: the timer that runs a new release's deploy is the release before's, and one from before 5 tried again every tick with no wait. To any other caller (that older timer, or a deploy by hand) the disk is 3, as it was, and it still says the disk is full. Under 64 MB left, a release that cannot install (npm's lockfile mismatch) is taken for the disk too, and not counted against it: a full disk whose error names no reason could not be told from it (eighth review). The channel files are written whole or not at all: a write that fails leaves the old value, not an empty file; one that is a link to a file (stow, a dotfiles folder) is written through, and the link kept. The records the swap and the checkout keep as they go (`.swapping`, its `in` lines and `restarted`, and the checkout's `restarted`) are judged the same way when a write fails: the disk is 5, after the old release is put back. Their errors are kept beside the lock, and one a killed run left there is removed by the next run to take the lock.
- **Fix:** free about 1 GB, then `rm ~/.local/state/hatchabot/follow-channel-failed*` (or run `hatchabot upgrade stable`).
- **Fixed in:** `v2.178.0`
- **Code:** `scripts/upgrade.sh` — `machine_short`, `said_kind`, `said_path`, `own_place`, `disk_short`, `step_tee`, `step_tail`, `new_step_log`, `run_step`, `step_short`, `put_rec`, `STEP_LOG`, `change_failed`, `disk_full`, `no_stage`, `swap_failed`, `pin_named`, `remember_channel`, `put_line`, `put_failed`, `unpin`, `take_lock`, `lock_short`; `scripts/follow-tries.sh` — `tries_open`, `tries_waiting`, `tries_put`, `note_try`, `forget_tries`, `HELD`; `scripts/follow-channel.sh` — `tries_open`, `note_try`; `scripts/deploy-release.sh` — `machine_short`, `said_kind`, `said_path`, `own_place`, `step_tee`, `step_short`, `put_rec`, `change_failed`, `STEP_LOG`, `take_lock`, `lock_short`, `put_dir`, `put_failed`, `finish`, `PROD`; `scripts/follow-latest.sh` — `tries_open`, `note_try`, `repair_cut`, `HATCHABOT_FOLLOW_KNOWS_5`

### An upgrade or deploy says "Putting vX back did not work either (above), so … may be part-way between vX and vY"
- **Check:** the lines above it give why the step failed and why the rollback did too (a checkout git refused, a file it could not replace); `ls ~/.local/state/hatchabot/upgrade-*.from` (a git install or production checkout) or `ls -a <install>/.swapping` (a bundle install) shows the record of the change is still there.
- **Cause:** a step of the upgrade (or deploy) failed, and putting the previous release back failed as well, so the install may hold some of each. Before v2.178.0 that was not said: the run went on to say the disk was full (exit 5), which reads as "the previous release is back as it was; try again later". Now it says the rollback did not work, names the two releases, says what to run, and exits 3. A bundle's rollback on the disk that filled no longer needs room: the unpacked bundle is removed first, and a `.swapping` it cannot rewrite as the files go back no longer stops it ("Could not write …/.swapping as the files went back (a full disk?): they are back all the same."), so the run ends as the disk's, exit 5. Before the twelfth review that ended "did not work either", exit 3, with the old release a rename from back. A rollback cut off after that (killed before it removed `.swapping`) is finished by the next run, which keeps the files it finds put back: the unpacked bundle is gone, so it cannot tell them from the new release's, and before the fourteenth review it removed them, and the install lost the old release's files.
- **Fix:** fix what the lines above name (free space, a permission, a stuck file), then run what it says: `hatchabot upgrade` on an install, or `scripts/deploy-release.sh vY` for a production checkout. Either one puts vX back first from the record it kept, before anything else (the timers do the same on their next tick).
- **Fixed in:** `v2.178.0`
- **Code:** `scripts/upgrade.sh` — `change_failed`, `REDO`, `undo`, `rollback_bundle`, `restore_prev`; `scripts/deploy-release.sh` — `change_failed`, `REDO`, `rollback`

### The channel timer says "Could not read …/follow-tries.sh: this tick keeps no count of its tries"
- **Check:** `ls -l scripts/follow-tries.sh` in the install (on the machine that follows the newest tag, beside `follow-latest.sh`): missing, or not readable by the user the timer runs as.
- **Cause:** both timers keep the count of a release's failed tries through that one file. Missing or unreadable (a checkout cut off part-way, a permission changed by hand), it stopped the timer before it could hand a cut-off upgrade to its repair. Since v2.178.0 the tick goes on without it: it counts nothing and waits for nothing, so it tries the upgrade (or the deploy) every tick, and says so.
- **Fix:** put it back: on a git install `git checkout -- scripts/follow-tries.sh`, on a bundle install `hatchabot upgrade` (it repairs a cut-off swap first), or fix its permissions.
- **Fixed in:** `v2.178.0`
- **Code:** `scripts/follow-channel.sh` — `tries_open`; `scripts/follow-latest.sh` — `TRIES_HELPER`

### An upgrade or deploy says "… is in the way of the upgrade lock"
- **Check:** `ls -l ~/.local/state/hatchabot/upgrade-*.lock.d`: the named path is a file, a symlink (dangling or not) or another kind of entry, not a folder.
- **Cause:** the upgrade lock is a folder made there for each run. Something else at that path (a file left by a tool, a link, or one made by hand) could never be taken, and before v2.178.0 every run said "Another upgrade … is running" (or, once the lock read failures as the disk, that the disk was full; a dangling symlink was read that way until the fourth review). Now it is named and the run refuses (exit 2) without changing anything. The same goes for a folder (or anything not a file) where `hatchabot upgrade` writes which channel the machine follows (`data/channel`, `~/.config/hatchabot/channel`) or a pin's record beside the lock, or where it writes them first (the same name with `.tmp`): "… is in the way". It said the disk was full (exit 5). Since the seventh review the same goes for the checkout's record beside the lock (`upgrade-<n>.from`, from `upgrade.sh` and `deploy-release.sh`) and for a file where the lock's folder (`~/.local/state/hatchabot`, or one above it) should be. Since the tenth review a file where a folder above any of these records goes (`~/.config/hatchabot` a file, or this install's `data`) is named the same way: mkdir's failure there read as the disk (exit 5). A link to a file there is written through (the file it names is replaced, the link stays); a link to no file, dangling or to a folder, is in the way.
- **Fix:** remove it (`rm` the path the message gives), then run the upgrade again.
- **Fixed in:** `v2.178.0`
- **Code:** `scripts/upgrade.sh` — `take_lock`, `lock_in_way`, `put_line`, `put_dir`, `link_end`, `put_failed`; `scripts/deploy-release.sh` — `take_lock`, `lock_in_way`, `put_line`, `put_dir`, `put_failed`

### With no network, the channel timer leaves an upgrade that was cut off half done
- **Check:** the install has `.swapping` (a bundle install) or `~/.local/state/hatchabot/upgrade-<number>.from` (a git install), and the machine is offline; `journalctl --user -u hatchabot-follow-channel` shows ticks that do nothing.
- **Cause:** before v2.178.0 a tick that could not find which release the channel names stopped there, before the repair, so the service stayed half changed until the network came back. Now the tick asks `upgrade.sh` for the repair alone (`HATCHABOT_UPGRADE_REPAIR_ONLY`), which needs nothing from the network; the release waits for a tick that can find it.
- **Fix:** upgrade. Until then, run `hatchabot upgrade` once the network is back: it repairs first.
- **Fixed in:** `v2.178.0`
- **Code:** `scripts/follow-channel.sh` — `repair_due`; `scripts/upgrade.sh` — `REPAIR_ONLY`

### Pinned with `hatchabot upgrade vX.Y.Z`, but the channel timer upgraded the machine again minutes later
- **Check:** `cat <install>/data/channel` (or `~/.config/hatchabot/channel`) names the pinned version, yet `journalctl --user -u hatchabot-follow-channel` shows a run that started before the pin finished and then upgraded ("Upgrading vX.Y.Z → …").
- **Cause:** the channel timer reads the channel, finds the release it names, and then runs `upgrade.sh` with that channel. Before v2.178.0 only a run with no channel named read the channel file again under the lock, so a pin (or another channel) set while the timer's run waited for the lock was undone by it, and the machine left the release it was pinned to. Now the timer's run, and any run naming stable, beta or latest, reads it again once the lock is held; when it holds a pinned version or another channel, it changes nothing, says "The channel changed while this waited: this machine now follows …, not …, so nothing was changed." and exits 4, which the timer reads as routine, as it reads a lock another upgrade holds: the tick ends quietly and counts nothing, so the release's tries and a release set aside stay as they were (thirteenth review: an exit 0 read as an upgrade done, and cleared both for a release never tried). The pin itself was kept all along: the next tick sees it and leaves the machine alone.
- **Fix:** upgrade. Until then, pin again: `hatchabot upgrade vX.Y.Z`.
- **Fixed in:** `v2.178.0`
- **Code:** `scripts/upgrade.sh` — `RECHECK`, `remembered_channel`; `scripts/follow-channel.sh` — `HATCHABOT_UPGRADE_BY_TIMER`

### A release whose native module will not compile is retried every hour and never set aside, as if the machine were at fault
- **Check:** `journalctl --user -u hatchabot-follow-channel` (or `-u hatchabot-follow-latest`): each try ends in the build's own errors (`gyp ERR! build error`, a compiler's `…: error: …`, `make: *** … Error 1`) and then "could not go ahead on this machine" or "This does not count against vX"; above them a warning such as `gyp WARN EACCES current user ("…") does not have permission to access the dev dir "…"`, or another line that says EACCES or "Permission denied" and names no path. The release's tries file (`~/.local/state/hatchabot/follow-channel-tries-<n>`, or `follow-latest-tries`) has a `.disk` beside it with the same count.
- **Cause:** the upgrade and the deploy judge a failed step by its last lines, and a line that said a permission was the machine's (exit 5, never counted against the release). Before v2.178.0 that held for a warning too, and for a line that names no path (gyp quotes its dev dir in double quotes, which were not read): a build that failed on its own was called the machine's, and the timer tried it again for ever. Now a warning (`WARN`, `npm warn`, `warning:`) decides nothing (its disk words still count: npm says a full disk as `npm WARN tar ENOSPC`), a path in double quotes is read like one in single quotes and judged by where it is, and the step's own words of failure (gyp's `ERR!`, a compiler's `error:` or `fatal error:`, make's `***`) outrank a permission line that names no place, which is the machine's only when nothing else says why (fifteenth review).
- **Fix:** upgrade. The release's build failure then counts against it: the timer waits longer each time and sets it aside after 8 tries in a row, until the channel's next release.
- **Fixed in:** `v2.178.0`
- **Code:** `scripts/upgrade.sh` — `said_kind`, `said_path`, `disk_words`, `own_place`; `scripts/deploy-release.sh` — `said_kind`, `said_path`, `disk_words`

### On a full disk the channel timer runs a failing release again every ten minutes, and never sets it aside
- **Check:** `journalctl --user -u hatchabot-follow-channel` (or `-u hatchabot-follow-latest`): a tick ends right after "failed and was rolled back" (or "did not complete 8 times in a row" is never reached) with a shell error naming `follow-channel-failed-<n>` (or `follow-latest-failed`): "No space left on device" or "Permission denied"; `df -h ~/.local/state`.
- **Cause:** before v2.178.0 the timer wrote the release it sets aside with a bare `>`. On a full disk, or a state folder it cannot write, that failed, and under `set -e` it ended the tick before the try was counted: the next tick ran the release again at once (one that did not start was rolled back again each time, the service restarted with it), and a write cut short could leave the record empty. Now the record is written whole (a temporary file, then a rename) and a failure is said: "Could not write … to set vX aside (a full disk?): this try is counted instead, so the next ones wait." The try is counted (in the user's runtime folder when the state folder cannot take it), so the next ticks wait as after any failure, and the first tick that can write sets the release aside. The follow-latest timer's own temporary files (the copy of itself it runs from, the new release's deploy script, GitHub's answer about the release) are the same: one it cannot write is said ("Could not write … (a full disk?), so this tick stops before changing anything."), counted as a try the disk failed, and the next ticks wait (fourteenth review: under `set -e` the tick ended there with no word, and every tick tried again). Its repair of a deploy cut off part-way is the same: one the disk stops (the deploy script says 5) is counted as a try the disk failed and said ("Putting vX back could not go ahead on this machine's disk"), and with a cut-off deploy to repair the next ticks wait on the disk's tries (an hour at most), never on the tag's own (fifteenth review: it was not counted, and a cut-off deploy passed over every wait, so the repair, or the deploy that repairs, ran every ten minutes while the disk stayed full). When git cannot copy the new tag's deploy script, its words are read with the steps' list (`disk_words`: "No space left on device", a disk quota, EDQUOT, ENOSPC) and a write that came up short, where its own list missed EDQUOT and a bare ENOSPC and said "Trying again next time" with no wait.
- **Fix:** free some space, or give the user back its state folder (`~/.local/state/hatchabot`); then upgrade.
- **Fixed in:** `v2.178.0`
- **Code:** `scripts/follow-channel.sh` — `set_aside`; `scripts/follow-latest.sh` — `set_aside`, `FAILED`, `disk_stop`, `NO_COPY`, `repair_cut`, `disk_waiting`, `disk_words`; `scripts/follow-tries.sh` — `note_try`, `HELD`

### The channel timer says "Another upgrade … is running" while `hatchabot upgrade` is only looking for the release
- **Check:** a hand-run `hatchabot upgrade` (or `hatchabot upgrade beta`) sits before its `Upgrading vA → vB` line, as it does with no network or a slow one, and `journalctl --user -u hatchabot-follow-channel` shows "Another upgrade of … is running" for the same minutes.
- **Cause:** before v2.178.0 the upgrade took the lock first and then asked which release the channel names, which with the network down can take minutes; all that while the timer's tick found the lock held and did nothing. Now the release is looked for before the lock is taken (only an upgrade that has to put back `scripts/` first looks under the lock). The channel it looked for, when it was read from the install's own file (no channel named on the command line), is read again once the lock is held: if another upgrade named another channel or pinned a release meanwhile, it changes nothing, says "While this looked for the release … another upgrade set this machine to follow …" and exits 4. The channel timer's run, and one with a channel named, read it again too (below).
- **Fix:** upgrade. Until then it is harmless: the tick that found the lock held runs again ten minutes later. For the message above, run `hatchabot upgrade` again.
- **Fixed in:** `v2.178.0`
- **Code:** `scripts/upgrade.sh` — `find_target`, `LOOKED`

### One of two installs under the same user stays on an old release, and its channel timer does nothing
- **Check:** `ls ~/.local/state/hatchabot/` has `follow-channel-failed` (no number after it) naming the release the channel is on, and `journalctl --user -u hatchabot-follow-channel` shows no upgrade attempt for it.
- **Cause:** before v2.168.0 every install of the user's shared one record of failed releases and retries: a release that failed on one install was set aside on the others too. Now each install keeps its own, keyed on its folder, as the upgrade lock is; the first install to look takes over the old shared record.
- **Fix:** upgrade the install that stayed behind by hand (`hatchabot upgrade stable`), or `rm ~/.local/state/hatchabot/follow-channel-failed*`.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/follow-channel.sh` — `KEY`

### Restart says "Service was restarted but isn't answering on port …" while the app works, and the upgrade rolls back
- **Check:** `.env` sets `HATCHABOT_TLS_CERT` (the service serves HTTPS itself) or `HATCHABOT_BIND` to one address; `curl -k https://localhost:<PORT>/healthz` (or `http://<bind address>:<PORT>/healthz`) answers.
- **Cause:** before v2.162.0, `scripts/restart.sh` always asked `http://localhost:<PORT>/healthz`, which a native-TLS listener or one bound to another address never answers; the upgrade took that as a failed release and rolled it back.
- **Fix:** upgrade (the upgrade restarts with the new release's script, so this upgrade is not rolled back). The probe now uses https when TLS is set and the bind address when it is one host.
- **Fixed in:** `v2.162.0`
- **Code:** `scripts/restart.sh` — `LISTENER`


### A restart, upgrade or deploy waits for good after the restart, and "Another upgrade … is running" stays
- **Check:** `ps -ef | grep curl` shows a `curl` started by `scripts/restart.sh` or `scripts/deploy-release.sh` that has run for minutes; the service took the connection but does not answer (`curl -v http://localhost:<PORT>/healthz` connects and then waits).
- **Cause:** before v2.178.0 the health check's `curl` had no time limit. A listener that took the connection and never answered (a hung service, a stuck proxy) held it for good, so the check never ended, the rollback never came, and the upgrade lock stayed held. Now each request has a connect and a total limit, and the wait a total one.
- **Fix:** upgrade. Until then, kill that `curl`: the check goes on, and rolls back if the service still does not answer.
- **Fixed in:** `v2.178.0`
- **Code:** `scripts/restart.sh` — `DEADLINE`; `scripts/deploy-release.sh` — `DEADLINE`

### The follow-latest timer says "Not deploying vX.Y.Z" for a new tag
- **Check:** `journalctl --user -u hatchabot-follow-latest` gives the reason; `curl -s https://api.github.com/repos/hatchabot/hatchabot/releases/tags/vX.Y.Z` shows the release (`"immutable": true`, a `release-manifest.json` asset), and `git -C ~/hatchabot-prod rev-parse vX.Y.Z^{commit}` is the manifest's `commit`.
- **Cause:** from v2.160.0 the timer deploys a v2.159.0-or-later tag only when it is a published, immutable release whose manifest is for that tag and names its commit. "Not a published release yet" is normal for a few minutes after tagging, while the release workflow runs. A manifest for another commit, a release that is not immutable, or one with no manifest means the tag did not come from the release workflow.
- **Fix:** for "not published yet", wait, or see why the release workflow stopped (`gh run list -w release.yml`). For a refused tag, do not deploy it by hand: find out who made it. After fixing, `rm ~/.local/state/hatchabot/follow-latest-failed` to let the timer look again.
- **Fixed in:** `v2.160.0` (#37)
- **Code:** `scripts/follow-latest.sh` — `verify_release`

### The follow-latest timer set a tag aside ("failed and was rolled back") though its deploy never started
- **Check:** `journalctl --user -u hatchabot-follow-latest` shows a git error such as `cannot lock ref 'refs/remotes/origin/main'` and no "Deploying vX.Y.Z to …" line; `cat ~/.local/state/hatchabot/follow-latest-failed` names the tag.
- **Cause:** before v2.168.0 `scripts/deploy-release.sh` exited 1, "this tag does not start", when its first `git fetch` failed (another fetch held the ref lock, or the network dropped), so the timer never tried that tag again. Now that is exit 3, tried again later.
- **Fix:** `rm ~/.local/state/hatchabot/follow-latest-failed`; the next tick deploys it (or deploy by hand: `scripts/deploy-release.sh vX.Y.Z`).
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/deploy-release.sh` — `finish`


### The follow-latest timer never deploys when the production folder has a space in its name
- **Check:** `grep HATCHABOT_PROD_DIR ~/.config/systemd/user/hatchabot-follow-latest.service` shows the folder without quotes; `journalctl --user -u hatchabot-follow-latest` says "No production checkout at" a shorter path, or systemd logs "Invalid environment assignment".
- **Cause:** before v2.178.0 `follow-latest.sh --install` wrote `Environment=HATCHABOT_PROD_DIR=<folder>` bare, and systemd cut it at the first space. `privacy-sync.sh --install` wrote its folder into `ExecStart` unescaped the same way, so a folder with a quote, `%` or `$` in its name ran another path. Now every unit writer quotes through one helper, as systemd reads it: a backslash or quote escaped, `%` doubled, and `$` doubled in `ExecStart`'s arguments.
- **Fix:** upgrade, then run `scripts/follow-latest.sh --install` (and `scripts/privacy-sync.sh --install`, where it is used) again to write the unit anew.
- **Fixed in:** `v2.178.0`
- **Code:** `scripts/systemd-quote.sh` — `systemd_quoted`, `systemd_arg`; `scripts/follow-latest.sh`; `scripts/privacy-sync.sh`

### `deploy-release.sh` says "Service restarted but is not serving X.Y.Z" and rolls back a release that was serving
- **Check:** production's `.env` sets `HATCHABOT_BIND` to one address, or sets `PORT` (or `HATCHABOT_TLS_CERT`) on more than one line; `curl -s http://<bind address>:<last PORT>/ | grep HATCHABOT_VERSION` shows the new version.
- **Cause:** before v2.168.0 the deploy always asked `127.0.0.1` and took the first `PORT` line, while the service listens at its bind address and uses the last line. A healthy release failed the check, was rolled back, and follow-latest set it aside.
- **Fix:** upgrade (deploy the next release by hand: `scripts/deploy-release.sh vX.Y.Z`), then `rm ~/.local/state/hatchabot/follow-latest-failed`. Keeping one line per setting in `.env` avoids the second cause.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/deploy-release.sh` — `envval`, `PROBE_HOST`; `scripts/restart.sh` — `LISTENER`

### A restart (or a deploy) says the service "isn't answering at http://localhost:8080", though `.env` sets another port with spaces around the =
- **Check:** `.env` has a line such as `PORT = 9137` (spaces around the `=`, or before the name); `curl -s http://localhost:9137/healthz` answers.
- **Cause:** systemd reads `PORT = 9137` as `PORT=9137`, but the restart, deploy, setup and first-run-link scripts looked only for `PORT=` at the start of a line. They probed the default port, waited a minute, and reported the service down; a deploy rolled back a healthy release.
- **Fix:** upgrade, or write the line as `PORT=9137`. On Linux the scripts now read spaces around the `=`, as systemd does. On a Mac the service's launchd job reads `.env` with bash, where only `PORT=9137` sets the port (`PORT = 9137` is a command and sets nothing, so the service listens on 8080): the scripts read it that way there, and the line must be `PORT=9137` for the port to change.
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/restart.sh` — `envval`, `envlines`; `scripts/deploy-release.sh` — `envval`; `scripts/first-run-link.sh` — `envval`, `envlines`; `scripts/setup-host.sh`

### After an upgrade or deploy was cut off, the next one failed and left no `node_modules` at all ("Cannot find module …")
- **Check:** `ls` in the install shows neither `node_modules` nor `node_modules.prev`; the log of the run before says it rolled back after a failed install.
- **Cause:** a run killed (or a power cut) right after it moved `node_modules` aside leaves `node_modules.prev` as the only working copy. Before v2.168.0 the next `scripts/upgrade.sh` or `scripts/deploy-release.sh` deleted it as a leftover, so when its own install failed there was nothing to roll back to. Now it is put back first.
- **Fix:** `./scripts/ensure-deps.sh` in the install (it needs the network), then `./scripts/restart.sh`. With a `node_modules.prev` still there and no `node_modules`, `mv node_modules.prev node_modules` brings the old ones back at once.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/upgrade.sh` — `restore_deps`; `scripts/deploy-release.sh` — `restore_deps`

### A bundle install is broken after an upgrade was cut off, and every upgrade since says "Already on vX.Y.Z"
- **Check:** the install has `BUNDLE.json` and no `.git`, and a `.prev-release` folder; some top-level folders (`scripts`, `.node`, `node_modules`, …) are missing or from the older release (`cat VERSION` against `BUNDLE.json`'s `tag`).
- **Cause:** a bundle upgrade swaps the new release in one top-level name at a time. Killed part-way (a power cut, SIGKILL), it left the tree half old, half new; before v2.169.0 it kept no record of that, `BUNDLE.json` was often the new one already, and every later run read it and stopped. From v2.169.0 the swap writes `.swapping` first and names each file in it before moving it in, swaps `scripts/` first, and the next run (or channel timer tick) puts the previous release back before it upgrades again.
- **Fix:** upgrade from a release with the fix: `hatchabot upgrade` repairs, then upgrades. On a tree cut off by an older release: in the install folder, for each name in `.prev-release`, `rm -rf ./<name>` then `mv .prev-release/<name> .`, then `hatchabot upgrade`. `.env` and `data/` are never part of the swap.
- **Fixed in:** `v2.169.0`
- **Code:** `scripts/upgrade.sh` — `restore_prev`, `SWAPPING`, `not_ours`; `scripts/follow-channel.sh` — `.swapping`

### A bundle install is missing top-level files (`VERSION`, `BUNDLE.json`, `scripts`, …) after an upgrade's rollback was cut off
- **Check:** the install has no `.git`; `ls -A` lacks a name the release has (compare its `.bundle-files`), and `.swapping` names it with an `in ` line. The upgrade before had failed to start the new release and was rolling back when it was stopped (a power cut, SIGKILL).
- **Cause:** a resumed rollback removed every name the new bundle brought in, including the ones its first attempt had already put back from `.prev-release`: those were the old release's files, lost for good. A swap cut off between writing a name down and moving the old file aside lost that file the same way. Now each file's `in` line is struck from `.swapping` before the file goes back, so a resumed rollback never removes it again, whichever release's `upgrade.sh` resumes it; the old file goes aside before its name is written down, and `scripts/` goes back first. A name still in the unpacked bundle (its `stage` line in `.swapping`) never moved in, so the file here is the old one and is kept: that covers a swap by an `upgrade.sh` from before the fix, which wrote the name down first.
- **Fix:** upgrade to a release with the fix before the next upgrade. To repair an install that lost files: download the old release's bundle (`hatchabot-vX.Y.Z-<platform>.tar.gz` from its release page), unpack it, copy the missing top-level names into the install folder, then `hatchabot upgrade`. `.env` and `data/` are never part of the swap.
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/upgrade.sh` — `restore_prev`, `rollback_bundle`


### A bundle install has no `scripts/upgrade.sh` after an upgrade's rollback failed, and the channel timer does nothing
- **Check:** the install has no `.git`; `scripts/` (or `scripts/upgrade.sh`) is missing while `.prev-release/scripts` is there; the upgrade's log says "Rolling back to vX.Y.Z" and then that the previous release could not be put back.
- **Cause:** before v2.178.0 the rollback removed each name before moving the previous release's copy back. When that move failed (a folder this user cannot write, a file system error), `scripts/` was gone, so neither the timer nor `hatchabot upgrade` had an `upgrade.sh` to run. Now the new release's copy goes aside first and comes back if the move fails. Nothing moves onto a name that is still there: a `.rollback-aside` a failed `rm` left is reported and the rollback stops, where it took the next copy inside itself and a put-back nested `scripts/scripts/`.
- **Fix:** fix what stopped the move (the log names it), then in the install folder `mv .prev-release/scripts .` and run `./scripts/upgrade.sh`: it puts the rest of the previous release back first.
- **Fixed in:** `v2.178.0`
- **Code:** `scripts/upgrade.sh` — `restore_prev`

### A bundle install has no `scripts/` but a `.rollback-scripts` and a `.rollback-aside` folder
- **Check:** the install has no `.git` and no `scripts/`; `ls -a` shows `.rollback-scripts` (the previous release's scripts) and `.rollback-aside` (the new release's), and `.swapping`.
- **Cause:** a rollback puts the previous release's `scripts/` back through a name beside it (`.rollback-scripts`) and then two renames back to back: the new one aside, the old one in. Before v2.178.0 more ran between those two (the `.swapping` record was rewritten), and a cut there (a power cut, SIGKILL) left no `scripts/`, so neither the timer nor `hatchabot upgrade` could run the repair. Now a cut anywhere else leaves a `scripts/` whose `upgrade.sh` finishes the job at its next start. Only a cut in the instant between the two renames leaves none: no portable rename swaps two folders at once. A `.rollback-scripts` left beside a `scripts/` (nothing under way: a cut-off swap is put back first) is removed when the next swap starts, under the lock, as `.rollback-aside` is: kept, a swap that then failed could not tell it from the old `scripts/` in `.prev-release`, said "… are both there", and left the install part-way (eighth review).
- **Fix:** in the install folder, `bash .rollback-aside/upgrade.sh`: once it holds the upgrade lock (a lock still held is left to its holder: exit 4, try again), it moves `.rollback-scripts` back to `scripts/` before it reads anything there, then puts the rest of the previous release back.
- **Fixed in:** `v2.178.0`
- **Code:** `scripts/upgrade.sh` — `restore_prev`, `not_ours`

### A git install is on the new release with half its dependencies after an upgrade was stopped, and every upgrade since says "Already on vX.Y.Z"
- **Check:** the install has a `.git` folder and a `node_modules.prev` folder; `git describe --tags` names the new release; `node_modules` lacks `.hatchabot-lock-stamp`. The upgrade was stopped while it installed dependencies (Ctrl-C, a closed terminal, `systemctl stop`, a power cut).
- **Cause:** stopped by a signal, `scripts/upgrade.sh` ended without putting the old release back, and it kept no record of being part-way: the next run read the new release as installed and stopped there. The service went on running the old release until its next restart, which then had to install the dependencies itself.
- **Fix:** upgrade from a release with the fix: a stopped upgrade now puts the old release back at once, and one killed outright (a power cut) is put back by the next `hatchabot upgrade` before it upgrades again. The channel timer runs that repair too from v2.171.0; before it, the timer took the new release as installed, so run `hatchabot upgrade` by hand. On an older release, in the install folder: `git checkout <the old tag>`, `rm -rf node_modules && mv node_modules.prev node_modules`, then `hatchabot upgrade`.
- **Fixed in:** `v2.170.0`
- **Code:** `scripts/upgrade.sh` — `FROM_FILE`, `rollback`, `finish`; `scripts/follow-channel.sh` — `KEY`

### Production is on the new tag with half its dependencies after a deploy was stopped
- **Check:** the production checkout (`~/hatchabot-prod`) has a `node_modules.prev` folder; `git -C ~/hatchabot-prod describe --tags` names the new tag; the deploy was stopped while it installed dependencies (`systemctl --user stop hatchabot-follow-latest`, a Ctrl-C, a closed terminal, a power cut).
- **Cause:** stopped by a signal, `scripts/deploy-release.sh` ended without putting the old release back, as `scripts/upgrade.sh` did before v2.170.0. It kept no record of being part-way, and its next run moved the half-installed `node_modules` aside and deleted the working one in `node_modules.prev`.
- **Fix:** upgrade: a stopped deploy now puts the old release back at once (every tracked file, even when the stop came during the checkout), and one killed outright is put back by the next deploy before it starts, which the follow-latest timer runs on its next tick though production is on the newest tag already. A deploy stopped only once the new release was serving says so and exits 0. On an older release, in the production checkout: `git checkout <the old tag>`, `rm -rf node_modules && mv node_modules.prev node_modules`, `systemctl --user restart hatchabot`, then deploy again.
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/deploy-release.sh` — `FROM_FILE`, `rollback`, `back_to_cur`, `finish`; `scripts/follow-latest.sh` — `CUT`

### `hatchabot upgrade beta` is undone: the channel file says stable again
- **Check:** `cat <install>/data/channel` (before v2.169.0, `~/.config/hatchabot/channel`) against `systemctl --user cat hatchabot-follow-channel` (its ExecStart channel).
- **Cause:** the timer's own upgrade saved its channel over the one chosen by hand.
- **Fix:** upgrade, then run `hatchabot upgrade beta` again (or reinstall the timer with `follow-channel.sh --install beta`). Before v2.168.0 the timer also went on following the channel it was installed with; see the next entry.
- **Fixed in:** `v2.153.0`
- **Code:** `scripts/upgrade.sh` — `HATCHABOT_UPGRADE_BY_TIMER`

### After `hatchabot upgrade beta`, the channel timer still upgrades along stable
- **Check:** `cat <install>/data/channel` (before v2.169.0, `~/.config/hatchabot/channel`) says `beta`, but `journalctl --user -u hatchabot-follow-channel` shows a new beta release never installed, or `newer than stable`; `systemctl --user cat hatchabot-follow-channel` names `stable` in its ExecStart.
- **Cause:** the timer resolved the channel named in its own unit on every tick and read the remembered channel only for a version pin, so switching channels changed what `hatchabot upgrade` follows but not what the timer follows.
- **Fix:** upgrade. From v2.168.0 each tick follows the channel chosen last (from v2.169.0 the install's `data/channel`, before it `~/.config/hatchabot/channel`; written by `hatchabot upgrade <channel>`, the installer and `follow-channel.sh --install`), and the unit's channel only when none is remembered. On an older release, reinstall the timer: `./scripts/follow-channel.sh --install beta`. Public access counts the channel the same way, so a switch away from stable turns its safeguard off.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/follow-channel.sh` — `REMEMBERED`; `src/ops/autoUpgrade.ts` — `autoUpgradeStatus`

### Choosing a channel in one install (`hatchabot upgrade beta`) moved another install of the same user onto it
- **Check:** two installs under one user (a test clone beside the one the service runs, say); `cat ~/.config/hatchabot/channel` names the channel chosen in the other one, and `journalctl --user -u hatchabot-follow-channel` shows the timer following it.
- **Cause:** before v2.169.0 the channel chosen last was one file for every install of the user's, `~/.config/hatchabot/channel`, so choosing a channel (or pinning a version) in one install changed what every other install's `hatchabot upgrade` and channel timer followed. From v2.169.0 each install keeps its own in its `data/channel`; the user's file is read only by an install with none of its own yet, and written only for a pin to a release from before v2.169.0, which reads nothing else.
- **Fix:** upgrade, then in each install name its channel once: `hatchabot upgrade stable` (or `beta`, or a version) from that install's folder.
- **Fixed in:** `v2.169.0`
- **Code:** `scripts/upgrade.sh` — `remember_channel`, `remembered_channel`; `scripts/follow-channel.sh` — `REMEMBERED`; `install.sh` — `remember_channel`; `src/ops/autoUpgrade.ts` — `autoUpgradeStatus`

### The channel timer keeps retrying a release that failed, and sets aside one it never tried
- **Check:** `cat ~/.local/state/hatchabot/follow-channel-failed` names a release older than the one in the timer's log line `Upgrading vA → vB` that failed, right after the channel was promoted.
- **Cause:** the timer resolved the channel, then upgrade.sh resolved it a second time. When the channel moved in between, upgrade.sh tried the newer release while the timer recorded the one it had resolved, so the release that failed was tried again on the next tick and the service restarted twice for nothing.
- **Fix:** upgrade. The timer now hands upgrade.sh the release it resolved, so the release tried is the one recorded. To let a set-aside release be tried again: `rm ~/.local/state/hatchabot/follow-channel-failed`.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/follow-channel.sh` — `HATCHABOT_UPGRADE_TARGET`; `scripts/upgrade.sh` — `HATCHABOT_UPGRADE_TARGET`

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

### The installer says "Docker's install script could not be checked" or "Node 22 could not be installed from NodeSource"
- **Check:** the line above it says `… is not the file this installer was checked with (its sha256 differs)` or `could not download …`.
- **Cause:** the installer runs Docker's install script only at the commit it pins, and adds NodeSource's apt repo only with the signing key it pins, each checked by its sha256 before anything runs as root. A download that failed, or a file that is not the pinned one (a changed key, a proxy rewriting the download), is refused. Before v2.169.0 it piped get.docker.com and NodeSource's setup script into a root shell unchecked, the second with `sudo -E`.
- **Fix:** install Docker (https://docs.docker.com/engine/install/) or Node 22+ (https://nodejs.org) by hand, then re-run the installer; it skips what is already there. A refused file that keeps being refused is worth a **Report a problem**: the pin may need moving.
- **Fixed in:** `v2.169.0`
- **Code:** `install.sh` — `fetch_pinned`, `nodesource_repo`, `DOCKER_INSTALL_COMMIT`

### The installer says "Could not download release vX.Y.Z's bundle, or what checks it, just now"
- **Check:** the line above it says `could not download hatchabot-…tar.gz: curl <n>, HTTP <code>` or `could not fetch the release's manifest`; `curl -sI https://github.com` from the same machine.
- **Cause:** the network (or GitHub) did not answer while the installer fetched the release's bundle or its manifest. Before v2.169.0 that silently became a native install instead (git, Node 22 and a compiler installed, then a clone), which the machine could run the bundle without.
- **Fix:** re-run the installer once the connection is back; nothing was installed. `HATCHABOT_NATIVE=1` installs from source on purpose.
- **Fixed in:** `v2.169.0`
- **Code:** `install.sh` — `install_bundle`

### The service never starts after setup, and its log says "Invalid environment assignment, ignoring" (Node in a folder with a space in its name)
- **Check:** `journalctl --user -u hatchabot` shows `Invalid environment assignment, ignoring: …` and then `env: 'bash': No such file or directory`; `systemctl --user cat hatchabot` has an `Environment=PATH=` line whose first folder has a space (Node installed there, or a bundle install in such a folder).
- **Cause:** the units' PATH line was written unquoted. systemd splits an unquoted assignment at a space, keeps the part before it as the whole PATH, and drops the rest (`/usr/bin:/bin` too), so the service cannot find `bash`. The channel timer's unit had the same line.
- **Fix:** upgrade, then run `./scripts/install-service.sh` in the install folder (and `./scripts/follow-channel.sh --install <channel>` if the timer is installed): the units are rewritten with the PATH quoted whole. Or by hand: change the line to `Environment="PATH=…"` in `~/.config/systemd/user/hatchabot.service` and `hatchabot-backup.service`, then `systemctl --user daemon-reload && systemctl --user restart hatchabot`.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/systemd-quote.sh` — `systemd_quoted`; `scripts/install-service.sh`; `deploy/hatchabot.service`; `scripts/follow-channel.sh` — `UNIT_PATH`

### The channel timer will not install: "node not found on PATH" or "docker not found on PATH"
- **Check:** `./scripts/follow-channel.sh --install <channel>` (or `follow-latest.sh --install`) stops with that line and writes no unit; `command -v node` or `command -v docker` prints nothing in the same shell.
- **Cause:** the timer's unit is given the folders of the `node` and `docker` this shell finds. Before v2.170.0 a missing one was guessed (`/usr/bin/docker`, or the current folder for node), and the unit then failed at every tick, out of sight in the journal.
- **Fix:** run it from a shell where `node --version` and `docker version` work (a bundle install finds its own Node). A timer installed by an older release with a wrong PATH: install it again the same way.
- **Fixed in:** `v2.170.0`
- **Code:** `scripts/follow-channel.sh` — `NODE_BIN`, `DOCKER_BIN`, `UNIT_PATH`; `scripts/follow-latest.sh` — `NODE_BIN`, `DOCKER_BIN`

### After a bundle install, an older native install's hatchabot command is broken, or the new command stops working once the old checkout is removed
- **Check:** `ls -l ~/.local/bin/hatchabot ~/.local/bin/hbt` shows links (`->`) into another checkout's `bin/hatchabot.mjs`, and `head -3 <that checkout>/bin/hatchabot.mjs` starts `#!/usr/bin/env bash` and `# Hatchabot (hatchabot) — written by scripts/link-cli.sh`.
- **Cause:** a native install's `npm link` had left those links. The bundle's link step wrote its launcher with a plain redirect, which follows a link: it overwrote the old checkout's CLI with the launcher, and the commands stayed links into the old checkout.
- **Fix:** upgrade, then `./scripts/link-cli.sh` in the bundle install: from v2.168.0 a link there is replaced by the launcher file. Then repair the old checkout's file if you keep it: `git -C <old checkout> checkout -- bin/hatchabot.mjs`.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/link-cli.sh` — `rm -f "$BIN/$name"`

### The hatchabot command says "No such file or directory" with a different folder than the install's (the install folder's name has `$`, a backtick or a quote in it)
- **Check:** `cat ~/.local/bin/hatchabot` shows the install folder inside double quotes with a `$`, `` ` `` or `"` in it, unescaped; running it names a folder where the `$NAME` part was replaced.
- **Cause:** the bundle's launchers put the folder inside double quotes as it was, so running the command expanded a `$` (or a backtick) in it a second time, and a quote ended the string early. The link step itself succeeded.
- **Fix:** upgrade, then `./scripts/link-cli.sh` in the install folder: the folder is written with those characters escaped (uninstall finds the launchers by the same text). On an older release, move the install to a folder whose name has none of them.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/link-cli.sh` — `HERE`; `scripts/uninstall.sh` — `REPO_IN_LAUNCHER`

### Re-running the installer on a clone install left it on a release it cannot run
- **Check:** `git -C ~/hatchabot describe --tags` shows the new tag, but the service fails on import, or `node_modules` is missing.
- **Cause:** the installer checked out and installed in place, with no lock and no rollback.
- **Fix:** `hatchabot upgrade <previous tag>`. From v2.153.0 re-running the installer goes through `upgrade.sh`.
- **Fixed in:** `v2.153.0`
- **Code:** `install.sh` — `native-existing`

### The first install stopped during setup (a runtime image pull that failed, say), and re-running the installer says "Already on vX.Y.Z" but nothing is set up
- **Check:** `systemctl --user cat hatchabot` (on a Mac, `ls ~/Library/LaunchAgents/com.hatchabot.control-plane.plist`) finds no service, and `ls ~/hatchabot/.env` may be missing too; `~/hatchabot/BUNDLE.json` (or a `.git` folder) is there.
- **Cause:** the installer took any unpacked bundle, and any clone with a `.env`, for a finished install and only upgraded it. Already on the release, the upgrade did nothing, so the setup (the `.env`, the runtime image, the service, the CLI) was never finished.
- **Fix:** run `./scripts/setup-host.sh` in the install folder (it keeps a `.env` already written). From v2.168.0 the installer counts an install as set up only when it has its `.env` and the service runs from it; otherwise re-running it finishes the setup (on the release unpacked then, for a bundle; `hatchabot upgrade` afterwards).
- **Fixed in:** `v2.168.0`
- **Code:** `install.sh` — `set_up`, `bundle-existing`

### After Node was upgraded to a new major version, the service will not start: "was compiled against a different Node.js version … NODE_MODULE_VERSION"
- **Check:** `journalctl --user -u hatchabot` (or `data/server.log` on a Mac) shows `NODE_MODULE_VERSION` for `better_sqlite3.node`; `node --version` is a newer major than when Hatchabot was installed; `./scripts/ensure-deps.sh` says "Dependencies are up to date."
- **Cause:** a native (clone) install whose database driver was compiled on the machine (an older C library, `scripts/sqlite-driver.sh`) keeps that build for the Node it was made with. ensure-deps.sh judged the dependencies by the lockfile alone, so a restart or setup after a Node upgrade never rebuilt the driver.
- **Fix:** `./scripts/sqlite-driver.sh` in the install folder (it compiles the driver for this Node), then `./scripts/restart.sh`. From v2.168.0 ensure-deps.sh records the Node the driver was checked under and checks it again (compiling it if it must) whenever Node changes.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/ensure-deps.sh` — `ABI_STAMP`; `scripts/sqlite-driver.sh` — `loads`

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

### A clean-install live test says "Not a pass: this run ended on vX, and the release under test is vY"
- **Check:** the last line of its run, `── N passed, 0 failed · vX · logs: … ──`, against `package.json`'s version; `docs/live-test-runs.md` has a `skip` row with "ended on vX" in its note.
- **Cause:** the clean installs take the public stable and upgrade to the public latest, not this checkout. The release under test is not public yet, or failed to publish, or `latest` has moved past it. These runs used to be recorded as passes on the checkout's version, so the gate cleared on older code.
- **Fix:** publish the release and run it again. If it is published but not the latest: `node scripts/live.mjs run clean-install -- --upgrade-to vY`.
- **Fixed in:** `v2.172.0`
- **Code:** `scripts/live.mjs` — `endedOn`, `resultOf`

### A clean-install live test says "the VM stopped by itself" or "the VM was not ready after 60 tries"
- **Check:** the run prints the machine's load average and points to `journalctl -u snap.lxd.daemon | grep 'Instance stopped'`; the run's `vm-stopped.log` under `~/hatchabot-clean-install/` holds what could be read for that VM.
- **Cause:** the failure is the VM's or the machine's, before or apart from anything Hatchabot did. Why VMs stop by themselves is not known: it was seen on Ubuntu 22.04 VMs at a load average of 36–39 and not on a quiet machine, but load is not proved to be the cause.
- **Fix:** run it again when the machine is quieter. If it keeps happening on a quiet machine, keep the run's `vm-stopped.log`.
- **Fixed in:** `v2.172.0`
- **Code:** `scripts/clean-install-test.sh` — `vm_failed`, `vm_stopped`, `save_vm_log`

### A clean-install live test says "the VM has no internet"
- **Check:** the lines under it say what was found: no default route, no answer from LXD's bridge, this machine offline too, or Docker's firewall. "LXD did not answer" means nothing was found out about the VM's network: the machine was too busy to say. Only that last one prints the two `iptables` commands. If it could not read the firewall without a password, look with `sudo iptables -S DOCKER-USER` and `sudo iptables -S FORWARD`.
- **Cause:** the VM's 24 pings failed after it was ready (two minutes at the least, longer when pings are dropped; the message says how long it was). The message used to blame Docker's firewall for any failed ping, and the ping could run before cloud-init was done.
- **Fix:** whichever the lines name. For Docker's firewall, the two commands it prints, once per boot.
- **Fixed in:** `v2.172.0`
- **Code:** `scripts/clean-install-test.sh` — `net_why`

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

### On a Mac, a `.env` value changed after a start: it named a lowercase variable, used `$((…))`, or had a quote after other text
- **Check:** `.env` has a line such as `PORT=$my_port` with `my_port=…` above it, `PORT=$((BASE_PORT+1))`, or a value like `NAME=text"first` that closes its quote on the next line; the newest `.env.bak-*` copy has the old order.
- **Cause:** at each start Hatchabot puts `.env` in order. It checked only for `$NAME` with an upper-case name, and for a quote at the start of a value, so it moved a lowercase line or an arithmetic one below the setting that used it, and split a value whose quote opened part-way through. The macOS launcher reads the file as a shell does, and got another value (or none).
- **Fix:** upgrade: such a file is now left as it is, with `env.sync_refused` naming the setting. If an older release already reordered it, put the lines back from the newest `.env.bak-*` copy, or write each value out in full. The log line "… has a quote part-way through its value that is not closed on its line" also comes on Linux, where systemd reads that quote as a plain character (`NAME=the family's house` is one line to the service): there it is only a warning that the file is not tidied. Write the value in double quotes (`NAME="the family's house"`) to let the tidy run.
- **Fixed in:** `v2.171.0`
- **Code:** `src/config/envFile.ts` — `multilineSetting`, `syncEnvText`, `assignments`

### On Linux the service does not start when Hatchabot is installed in a folder with a % in its name
- **Check:** the install's path has a `%` (or a `$`) in it; `systemctl --user status hatchabot` says the program "is not executable: No such file or directory", naming another folder; `grep -E '^(WorkingDirectory|ExecStart)' ~/.config/systemd/user/hatchabot.service` shows a single `%`.
- **Cause:** systemd reads `%q`, `%h` and the like in a unit as specifiers, and `${NAME}` in a program's arguments as a variable. The installer wrote the folder into the units as it is, so systemd looked in another folder.
- **Fix:** upgrade and run `./scripts/install-service.sh` again (and `./scripts/follow-channel.sh --install <channel>` if you use it), or move the install to a folder without `%`. The units now carry the folder with `%` doubled, and `$` doubled in a program's arguments.
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/systemd-quote.sh` — `systemd_quoted`, `systemd_arg`; `scripts/install-service.sh`; `scripts/follow-channel.sh`; read back by `install.sh`, `scripts/uninstall.sh` and `src/ops/autoUpgrade.ts` — `autoUpgradeStatus`

### A new terminal says "hatchabot: command not found" after installing, when the home folder's name has a $ or a backtick in it
- **Check:** `tail -n 3 ~/.bashrc` (or `~/.zshrc`) shows the `# hatchabot CLI` line with an unescaped `$`, backtick or quote in the path; `echo "$PATH"` in a new terminal lacks your `~/.local/bin`.
- **Cause:** `link-cli.sh` wrote the folder inside the line's double quotes as it is, so every new shell expanded the `$…` (or ran the backticks) and put another folder on the PATH.
- **Fix:** upgrade and run `./scripts/link-cli.sh` again, then delete the old `# hatchabot CLI` line from the profile. The line now escapes `$`, backticks, quotes and backslashes, as the launchers do.
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/link-cli.sh`

### Releasing: a tag made with `scripts/release.sh` has not reached the public repo
- **Check:** `./scripts/channels.sh` marks it `not-published`; the publisher's issues (`cksci/publisher`) have a digest issue `hatchabot vX.Y.Z publishes at <time>`, or an issue saying it was blocked or could not be gated.
- **Cause:** a release reaches the public repo only through the publisher: it gates the tag on its next run, waits an hour, and publishes on the first run after that. GitHub starts its scheduled runs hours apart. A gate hit stops the release for good; a `reject` label or the `HOLD` variable keeps it back.
- **Fix:** none needed for a release still waiting; to go sooner, start a run: `gh workflow run publish.yml -R cksci/publisher` (or Actions → publish → Run workflow in the browser). Blocked: fix what the issue names (rule, path, line; never the value) and release the next patch version. Held: clear `HOLD`.
- **Fixed in:** —
- **Code:** `scripts/release.sh` — `refs/tags/$TAG`; `docs/releasing.md` — `How a release reaches the public repo`

### Releasing: the publisher blocked a release for a fingerprint hit across two lines (`path:N-N+1`)
- **Check:** the publisher's issue for the release names a fingerprint hit at two lines in a row, such as `docs/features.md:9-10`, and the release passed `scripts/release.sh`'s own privacy check.
- **Cause:** a private name was wrapped onto the next line, in a paragraph or a comment. The publisher's gate reads each line break, but the privacy check here read a line at a time, so the name went through the pre-push hook and CI's `privacy` job.
- **Fix:** reword each place it names, describing the agent or person by kind, and release the next patch version. Don't put the name in the CHANGELOG, the release notes or a commit message. To find others before tagging, run `git ls-files -z | xargs -0 node scripts/privacy-check.mjs --text`. It prints each hit masked; the owner's own address in `scripts/privacy-identity.txt` is expected there.
- **Fixed in:** `v2.164.3`
- **Code:** `scripts/privacy-check.mjs` — `scan`; `scripts/privacy-ci.mjs` — `scanAcross`, `scanText`, `scanRange`

### Releasing: the publisher blocked a release for a `[fingerprint] M` (machine) hit that the local check passed
- **Check:** the publisher's issue names `[fingerprint] M` lines, and `node scripts/privacy-check.mjs --text <file>` on those files says they name nothing private. Its `not covered:` line says `machine names seen before (no record yet …)`, or the result is `✗ incomplete: the record of machine names seen before … could not be read` (exit 3).
- **Cause:** the local check read machine names only from the peers `tailscale status` listed at that moment. The publisher gates with the names from its last `kit values sync`, so a machine that has left the tailnet since was still in its set, and the hit showed up only an hour after the tag.
- **Fix:** reword each line it names, using a made-up host such as `Sams-Notebook`, and release the next patch version. The check now keeps every machine and tailnet name it has seen in `~/.config/hatchabot/privacy-machines.json` (mode 600, never in a repo) and checks those too. The record starts the first time it runs on a machine, so a machine that left before then is not in it: add its name to the file's `machine` list by hand. An unreadable record stops the check (exit 3) until it is moved aside; docs/releasing.md, "The privacy check", says how to forget a machine.
- **Fixed in:** the release after `v2.173.1`
- **Code:** `scripts/privacy-check.mjs` — `tailnetValues`, `seenMachinesFile`

### `scripts/promote.sh`: "vX.Y.Z is not published yet (the public repo has no such tag)"
- **Check:** `git ls-remote --tags public refs/tags/vX.Y.Z` prints nothing.
- **Cause:** only a published release can be moved to a channel, and the publisher has not pushed it yet (above). The publisher's fast lane would refuse a `channels.json` naming it.
- **Fix:** wait until it is published (`./scripts/channels.sh` no longer marks it `not-published`), then promote it.
- **Fixed in:** `v2.164.0`
- **Code:** `scripts/promote.sh` — `PUB_TAG`

### `scripts/promote.sh`: "CI failed on vX.Y.Z" right after "CI for vX.Y.Z is still running — waiting for it…", though the run passes
- **Check:** `gh run list --repo cksci/hatchabot-dev --workflow ci.yml --limit 3` shows the run in progress or passed; `gh run watch <id>` fails with "Resource not accessible by personal access token"; `gh auth status` shows a `github_pat_` token.
- **Cause:** promote waited with `gh run watch`, which reads the check-run annotations that a fine-grained token cannot read (HTTP 403); its failure was taken for a failed run. `scripts/release-check.sh` had the same wait and was fixed in v2.166.1.
- **Fix:** upgrade the checkout: promote now polls the run listing until the run finishes (up to `HATCHABOT_CI_WAIT_SECS`, 45 minutes), as release-check does. On an older checkout, wait until the run has passed, then promote again.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/promote.sh` — `ci_gate`, `HATCHABOT_CI_WAIT_SECS`

### `scripts/release.sh` or `scripts/promote.sh`: "No remote 'public' for the public repo"
- **Check:** `git remote -v` lists no `public`.
- **Cause:** a clone made before the dev repo, or a fresh clone of the dev repo: the scripts read the public repo (tags, `channels.json`) through a read-only remote.
- **Fix:** `git remote add --no-tags public https://github.com/hatchabot/hatchabot.git && git remote set-url --push public DISABLED`.
- **Fixed in:** `v2.164.0`
- **Code:** `scripts/release.sh` — `HATCHABOT_PUBLIC_REMOTE`; `scripts/promote.sh` — `HATCHABOT_PUBLIC_REMOTE`

### `scripts/land.sh` waits until its timeout though the pull request's checks passed
- **Check:** `gh pr checks <number> --repo cksci/hatchabot-dev` says "Resource not accessible by personal access token"; `gh auth status` shows a `github_pat_` token.
- **Cause:** `gh pr checks` reads the check-runs API, which needs a permission ("Checks") that fine-grained personal tokens cannot have; the machine's everyday token is one (publish kit D8). Before this fix, `land.sh` saw no checks and kept waiting.
- **Fix:** upgrade the checkout: `land.sh` reads the jobs of the commit's Actions runs on its branch, and the commit's statuses (the token's Actions and Commit statuses read access). To land a pull request already waiting: `gh pr merge <url> --rebase --delete-branch` once its CI run passed, then `git pull --rebase`.
- **Fixed in:** the release after `v2.164.1` (2026-10-17)
- **Code:** `scripts/land.sh` — `checks`

### `scripts/land.sh` said a failed pull request "is closed and its branch deleted", but it is still open (and may merge)
- **Check:** `gh pr list --repo cksci/hatchabot-dev --state open` still lists the `land/…` pull request, with auto-merge on; `git ls-remote --heads origin 'land/*'` still has its branch.
- **Cause:** on a failed check land.sh turned auto-merge off and closed the pull request, ignoring whether either request worked, and then said it was closed. When GitHub refused both (an outage, a token without the right), the pull request stayed open with auto-merge on, and a failed check that is not a required one does not stop GitHub merging it.
- **Fix:** close it: `gh pr close <url> --repo cksci/hatchabot-dev --delete-branch`. From v2.168.0 land.sh asks GitHub afterwards: closed is said only when GitHub says so; otherwise it names the pull request, says whether auto-merge is still on, gives the command to close it, and exits 3 (promote.sh then says the promote's pull request is still open).
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/land.sh` — `fail`

### After `scripts/promote.sh`, the channel moved but the runtime image's `:stable` (or `:beta`) did not (before v2.164.0: "Moving the image :stable failed")
- **Check:** the public repo's Actions → Promote images: a run for the `Update channels` push failed, or none ran yet because the publisher has not copied `channels.json` (the public `channels.json` still names the old release).
- **Cause:** the image alias moves on the public repo, when the publisher's fast lane pushes `channels.json`; a release made before `release-manifest.json` has no image to move by digest. A move fails on a registry error, a missing attestation, or a `:vX.Y.Z` that names another digest (the run says which).
- **Fix:** wait for the fast lane (start a publisher run to go sooner). A failed move: Actions → Promote images → Run workflow, with the version and the alias (and "allow backwards" for a rollback).
- **Fixed in:** `v2.164.0`
- **Code:** `.github/workflows/promote-images.yml` — `plan`, `allow_backwards`

## Sign-in and accounts

### Hatchabot will not start: "Refusing to start: sign-in is off, and under Docker Desktop every agent can reach this process"
- **Check:** the install's `.env` has no `HATCHABOT_PASSWORD` and `HATCHABOT_AUTH` is `password` or unset, and the machine is a Mac (or runs Docker Desktop on Linux). `hatchabot logs` shows the line at start.
- **Cause:** with sign-in off every request is treated as the owner. On Docker Desktop, agents reach Hatchabot at `host.docker.internal`, which is this machine's loopback, so any agent could call its API with the owner's powers. Rootless Docker was refused already; Docker Desktop was not (HB-0238).
- **Fix:** turn sign-in on: `HATCHABOT_AUTH=accounts` in `.env` (the installer's default), or set a `HATCHABOT_PASSWORD`, then restart. A machine that is truly not Docker Desktop can say so with `HATCHABOT_DOCKER_DESKTOP=0`.
- **Fixed in:** `v2.175.0`
- **Code:** `src/api/auth.ts` — `noSignInRefusal`, `loopbackIsRemote`; `src/index.ts`

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

### Google sign-in mode: a new email-and-password account says "Verify your email address, then sign in again", and no email came
- **Check:** the install uses `HATCHABOT_AUTH=identity`; the account was made with **Create account** (not the Google button); no email from the project's Identity Platform arrived, spam folder included.
- **Cause:** the server refuses an unverified email address (anyone could otherwise sign up as anyone), but before v2.162.0 the app never asked Identity Platform to send the verification email.
- **Fix:** upgrade; **Create account** now sends the link and says where it went, and signing in before it was opened offers **Send the link again**. Or sign in with the Google button, which arrives verified.
- **Fixed in:** `v2.162.0`
- **Code:** `web/index.html` — `idSendVerification`, `idSignUp`; `src/api/identity.ts` — `principalFor`

### The sign-in screen says "This page is open over plain http from another device"
- **Check:** the address bar shows `http://` and a LAN address or name (not `localhost` or `127.0.0.1`).
- **Cause:** over plain http, what you sign in with (a password, or Google's sign-in token) and the session cookie it starts cross your network unencrypted, so anyone who can watch that network can copy the session. The sign-in still works; the notice says so.
- **Fix:** open Hatchabot at its https address (the setup guide's "Turn on HTTPS" step: the tailnet address), or on the machine itself at `http://localhost:8080`.
- **Fixed in:** `v2.169.0`
- **Code:** `web/index.html` — `plainHttpFromAfar`, `showLogin`

### "Sign out" seemed to work, but the app is back, still signed in
- **Check:** the page said nothing and reloaded into the app; the service was restarting or the network dropped at that moment.
- **Cause:** the session cookie can only be ended by the server; before v2.162.0 a sign-out that never reached it was treated as done, and the reload found the cookie still valid.
- **Fix:** upgrade; such a sign-out now says "Not signed out … This browser is still signed in" and stays put, so Sign out can be pressed again. On an older version, press Sign out again once the app answers (or "Sign out on every device").
- **Fixed in:** `v2.162.0`
- **Code:** `web/index.html` — `signOut`

### Creating the first account asks for a "setup code"
- **Check:** you are on the first-run page from another device than the Hatchabot machine, or under rootless Docker, or on Docker Desktop (a Mac: from `v2.169.0` even at `localhost`).
- **Cause:** by design: before any account exists, only someone on the machine itself, or holding the code printed at start-up, may create the owner account. Under rootless Docker and Docker Desktop an agent's request reaches Hatchabot from the machine's own loopback, so loopback is not proof of being on the machine there, and the code is asked of everyone (before `v2.169.0` a prompt-injected agent on a Mac could create the owner account in that window).
- **Fix:** use the link the installer printed (it carries the code after `#setup=`), or find "first-run setup code" in the server log (`data/server.log` on a Mac), or run `hatchabot accounts create <you> --host-owner` on the machine.
- **Fixed in:** `v2.169.0` (Docker Desktop asks for the code too)
- **Code:** `src/index.ts` — `first-run setup code`; `src/api/accountsAuth.ts` — `onThisMachine`; `src/api/auth.ts` — `loopbackIsRemote`; `src/ops/opsServer.ts` — `dockerDesktop`; `scripts/first-run-link.sh` — `setup=`

### Sign-in refuses after several wrong passwords
- **Check:** the sign-in answers "Too many failed attempts — try again later." (HTTP 429).
- **Cause:** the sign-in throttle: 10 failures per 15 minutes per address (`HATCHABOT_LOGIN_FAILS_PER_WINDOW`). Before v2.97.1, ten wrong guesses in password mode could lock out everyone.
- **Fix:** wait 15 minutes; a forgotten password is reset as in the next entry.
- **Fixed in:** `v2.97.1`
- **Code:** `src/api/auth.ts` — `HATCHABOT_LOGIN_FAILS_PER_WINDOW`, `FAIL_WINDOW_MS`

### An invitation or reset link says "Too many attempts — try again later."
- **Check:** the link's page answers 429 after several links that had been used or had expired were opened from the same address.
- **Cause:** from `v2.169.0` the link lookup (`GET /v1/local-accounts/claim`) counts misses like sign-in does (10 per 15 minutes per address), so codes cannot be guessed at speed. It is the links' own count: the password form is not locked by it.
- **Fix:** wait 15 minutes, then open the newest link; ask for a new one if it has expired.
- **Fixed in:** `v2.169.0`
- **Code:** `src/api/accountsAuth.ts` — `registerAccountRoutes`; `src/api/auth.ts` — `throttleKeys`

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

### A second factor nobody recognises on a member's account, or their password stopped working, with public access on
- **Check:** Settings → Security record shows `second_factor.added` for an account with no factor before it, after a password change or recovery the person did not make; the service log shows `account.recovery_code_created` for that account shortly before it.
- **Cause:** before v2.172.2, someone holding only a member's password could make a recovery code at the public address, use it, and add their own authenticator, because a recovery code counts as proof sent out of band. Accounts with owner rights, and accounts that already had a factor, could not be taken this way.
- **Fix:** upgrade. If it happened: as the owner, at the private address, run `hatchabot second-factor reset <user>` and send the person a reset link. A code made before the upgrade stays good until it is used or replaced, so have anyone with no factor who may have lost their password make a new one, which replaces the old.
- **Fixed in:** `v2.172.2`
- **Code:** `src/api/publicRoutes.ts` — `me\/recovery-code`; `src/api/publicAccess.ts` — `FIRST_FACTOR_PROOF`

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

### An authenticator app was added after a factor was removed or a password reset ("Your password or second factors changed while this was being checked")
- **Check:** the security record shows `second_factor.added` (totp) after a `second_factor.removed` or a password reset; or adding one now says "Your password or second factors changed while this was being checked", or confirming one says "This setup was cancelled" right after a factor was removed.
- **Cause:** an authenticator app shown before a factor was removed could still be confirmed after it, and a password checked while it was being reset (or the person's factors reset) still counted.
- **Fix:** upgrade. Remove any factor you did not add; then add the app again: start over from **Add an authenticator app**, and sign in again first if your password was reset.
- **Fixed in:** `v2.171.0`
- **Code:** `src/api/secondFactor.ts` — `proveManage`, `forgetCeremonies`

### "This setup was cancelled" with the Add an authenticator app box still open
- **Check:** Settings → You, with **Add an authenticator app** open: a factor was removed (here or in another tab) or reset by the owner, and the box stayed on the page. A code typed there is refused with "This setup was cancelled", or an older message telling you to close a box that has no close button.
- **Cause:** removing or resetting a factor cancels an app still being added, on the server, but the page kept its box open and its QR code on show.
- **Fix:** upgrade; the box closes when a factor is removed and when the server says the setup was cancelled. On an older version press **Add an authenticator app** again: it starts over, and any new QR code replaces the old one in the box. A code from the old QR code will not work: remove that entry from the app and scan the new one.
- **Fixed in:** `v2.172.0`
- **Code:** `web/index.html` — `sfCloseTotp`, `sfRemove`, `sfConfirmTotp`; `src/api/secondFactor.ts` — `'/v1/second-factor/totp/confirm'`

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

### After `HATCHABOT_URL=… hatchabot login`, other commands go to another server, or say the token was minted for another one
- **Check:** `~/.config/hatchabot/env` has a `HATCHABOT_URL=` line naming another server than the one you signed in to, and the login was made with `HATCHABOT_URL` set rather than `--url`.
- **Cause:** login saved the server only when it came from `--url`. Signed in through `HATCHABOT_URL`, the new token was saved beside the old server's address, and later commands sent it there.
- **Fix:** upgrade, then log in again the same way: the server and its token are saved together. On an older release, use `--url`. If the token may have gone to a server that is not yours, revoke it (⚙ Settings → Security) and make a new one.
- **Fixed in:** `v2.178.0`
- **Code:** `src/cli.ts` — `doLogin`, `writeConfigValues`

### `hatchabot login --email` says "signed in as …", but commands still act as the account used before
- **Check:** `~/.config/hatchabot/env` holds both `HATCHABOT_TOKEN=` (or the old spelling, `AGENTCLAW_TOKEN=`) and `HATCHABOT_REFRESH_TOKEN=`, or `HATCHABOT_TOKEN` is set in your shell.
- **Cause:** a saved access token is used before an email sign-in, and the email sign-in left the old token in place. A line in the old spelling is read as the same setting, and a sign-in took out only the new spelling.
- **Fix:** upgrade, then sign in again: each login keeps only its own credential, in either spelling. On an older release, take the `HATCHABOT_TOKEN=` and `AGENTCLAW_TOKEN=` lines out of the file. A `HATCHABOT_TOKEN` in your shell still comes first (login now says so, for an email sign-in and for `--token` with another token): unset it.
- **Fixed in:** `v2.178.0`
- **Code:** `src/cli.ts` — `doLogin`, `envTokenNote`

### After a sign-in on a shared browser, Settings → AI shows an API key the last person typed, or the plan box their text
- **Check:** one person's session ended on that page (the sign-in screen appeared by itself) and another account signed in without the page being reloaded. **Add another AI source** still held a key, token or name the first person typed and did not add, or **Plan an agent…** on the home screen held their text.
- **Cause:** the sign-in cleared dialogs, report text and unsaved source edits, but not these boxes. An unsaved key is a credential: pressing **Add source** would have saved it as the new person's source.
- **Fix:** upgrade: when another account signs in, the add-a-source form (key, token, name and models) and the plan box are emptied, and the page loads again (see "Another account signed in on a shared browser…" below). A setup token that was added is now cleared from its box too, as an API key already was. On an older release, reload the page before handing it over.
- **Fixed in:** `v2.174.0`
- **Code:** `web/index.html` — `pageClearLast`, `addAiProfile`

### Backup codes or a recovery code closed before you saved them, after the sign-in screen appeared by itself
- **Check:** the codes (or the recovery code) were on the screen when the session ended, you signed back in as yourself on the same page without reloading it, and they were gone. Settings → You shows the codes were made (fewer left than you saved, or a recovery code dated today you never saw).
- **Cause:** a sign-in closes what the last person had open. When the page had never read who you were, or could not read it at that sign-in, it could not tell you were the same person, and closed your codes with the rest. Until then they also stayed on the screen, dimmed, under the sign-in.
- **Fix:** upgrade: codes open when the session ends leave the screen, and wait with whose they are (the server now says so with them). Sign in again as yourself and they are back, until you tick that you have saved them; if who you are cannot be read yet, they come back at the first read that works. Another account never sees them, and codes shown with no owner are given back to nobody. A click outside the codes, or Esc, no longer closes them before you tick that you have saved them. Codes that answer after the session ended wait behind the sign-in for their person too, and the recovery code made by **Turn on family accounts** is shown to the owner making the switch. On any release, codes you did not save can be replaced: **Make new backup codes**, or make a new recovery code, in Settings → You.
- **Fixed in:** `v2.174.0`
- **Code:** `web/index.html` — `pageSecretShown`, `pageSecretNotHere`, `pageSecretLater`, `pageSecretsPutAway`, `pageSecretsBack`, `pageClearLast`, `showBackupCodes`, `showRecoveryCode`; `src/api/secondFactor.ts`; `src/api/accountsAuth.ts`; `src/api/routes.ts`

### Another account signed in on a shared browser, and a form still held the last person's text
- **Check:** one person's session ended on that page, or another tab signed in as someone else, and the page was not reloaded. A form such as the new-agent or task form still held what the first person typed, or a list was theirs until the next refresh.
- **Cause:** a sign-in cleared what the page knew to clear (dialogs, chat drafts, report text, the add-a-source form), but the page keeps more for a person than that, and none of the rest was reset.
- **Fix:** upgrade: when the page reads that another account than the one it showed is signed in, it loads again. It waits while a second-factor step is under way, so nothing that must be seen is lost: a sign-in finishing and the recovery code it shows, the second-factor prompt and the request it was for, an authenticator app or a passkey being added, a request for new codes, and backup codes or a recovery code on the screen. It reloads once that step ends. New codes that answer after the switch belong to the last account and are not shown to the new one (it says so; make new ones in Settings → You). The same account signing back in, or a first sign-in on a fresh page, does not reload. Another tab's switch is noticed when this tab is shown again, or at its next refresh. Until the reload, every password box and free-text form is emptied. On an older release, reload the page before handing it over.
- **Fixed in:** `v2.174.0`
- **Code:** `web/index.html` — `pagePersonIs`, `pageReloadWhenQuiet`, `pageSecondFactorBusy`, `pageHold`, `pageSigningIn`, `pageSignedIn`, `pageClearLast`, `sfDone`

### The second-factor prompt went away after a click beside it, and nothing asks for it again
- **Check:** at the public address, the "Confirm it is you" or "One more step" box closed on a click outside it or Esc, and since then a sensitive change (or the whole page) waits with no prompt.
- **Cause:** a click outside closed the prompt without answering it, and every later request waited on that same unanswered prompt without showing it.
- **Fix:** upgrade: the prompt closes only by **Continue**, a passkey or **Cancel**, and it comes back if it is ever off the screen while a request waits on it. A prompt belongs to the session and the person it was raised for: when that session ends, when the page reads that someone else is signed in, or when the factor given turns out to be another account's (signed in in another tab or window meanwhile), the request waiting on it is answered "The second factor was not given." and is not sent, so nothing one person asked for is sent again under the next person's sign-in. On an older release, reload the page.
- **Fixed in:** `v2.174.0`
- **Code:** `web/index.html` — `askSecondFactor`, `sfDone`, `sfCancel`, `sfDrop`, `pageSessionEnded`, `pagePersonIs`

### A member's Settings shows forms that only answer "Only the account that set up this machine can do that"
- **Check:** you are signed in with an account that does not own the machine (Settings → You has no host owner chip), and the refusal came from Voice & media key, Fleet search key, Add a runner, the "Every bot this server has a token for" drawer or the Default box on a source.
- **Cause:** those forms were drawn for everyone, and the server refuses them for anyone but the owner, as it should.
- **Fix:** nothing to repair: ask the machine's owner. Upgrade and they are hidden from other accounts.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `paintMachineOwnerOnly`, `renderAiList`

### A request with a damaged session cookie answered 500 instead of asking to sign in
- **Check:** the service log shows `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` ("Input buffers must have the same byte length") for a request whose session cookie (or public-address pass) ends in something other than 64 plain hex characters, such as accented letters.
- **Cause:** the cookie's signature was compared by its number of characters, then byte for byte; a signature of 64 characters that are more than 64 bytes made the comparison throw. Every sign-in mode (password, accounts, Google) and the public-address pass read it that way. Nothing was let in.
- **Fix:** none needed: sign in again, or clear the site's cookies. Since the fix, such a cookie is read as no sign-in (401).
- **Fixed in:** `v2.178.0`
- **Code:** `src/util/safeEqual.ts` — `safeEqual`; `src/api/accountsAuth.ts` — `sessionAccount`; `src/api/auth.ts` — `validSession`, `readSession`; `src/api/publicAccess.ts` — `decodePass`

## AI sources and Claude login

### An agent answers "Your model provider needs a new login" or "Not logged in · Please run /login", while the same source works for other agents
- **Check:** the agent's Setup log has `runtime.pins_cleared` after the fix, or, inside the container, `openclaw gateway call sessions.list` shows its sessions pinned to the `claude-cli` runtime.
- **Cause:** OpenClaw pins a runtime per conversation. Agents that once ran through the Claude Code CLI kept that pin after switching to a setup token, and the CLI has no login in the container.
- **Fix:** upgrade, then start or rebuild the agent: pins to runtimes its settings no longer name are cleared at rebuild, start, wake and boot. Do not replace tokens first.
- **Fixed in:** `v2.86.1`
- **Code:** `src/orchestrator/runtimePins.ts` — `clearStaleRuntimePins`; `src/orchestrator/eventLabels.ts` — `runtime.pins_cleared`

### Right after an import (a downloaded copy, or a move from another Hatchabot), the agent answers "Not logged in · Please run /login"
- **Check:** the copy came from a machine where its source rode the Claude Code CLI (a machine login), and here its source is a setup token or an API key; its Setup log has no `runtime.pins_cleared` since the import; a Stop and Start makes it answer.
- **Cause:** its conversations kept the runtime they were pinned to there (`claude-cli`), which has no login in this container, and the import, unlike a start or a rebuild, did not clear pins its new settings no longer name.
- **Fix:** upgrade; an import clears them once the agent is up. On an older version, stop and start the agent (or rebuild it).
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/transfer.ts` — `importAgent`; `src/orchestrator/runtimePins.ts` — `clearStaleRuntimePins`

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

### An agent left unticked when a source's default changed ran on another model after its next rebuild
- **Check:** the source's default had been changed once before without applying it to that agent (it still ran its old model), then changed again with that agent left unticked; its AI tab now names the earlier, never-applied default as its own model.
- **Cause:** before v2.168.0 "stay on the model they run today" pinned a follower to the source's current default, even when that default had never been applied to it, so the "held" agent moved to it at its next rebuild.
- **Fix:** upgrade: an unticked follower is pinned to the model it was last built with on that source. For an agent already pinned wrongly, pick its model again on its AI tab.
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/routes.ts` — `apply-default-model`

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

### Changing an agent's AI source (or its image, or its peers) rebuilt a different agent
- **Check:** you pressed Use this (or saved an image pin or a peers list) for one agent, closed its sheet and opened another agent's before "Saved. Rebuild now?" appeared; the first agent shows the new setting but was not rebuilt, and the agent whose sheet was open restarted (its timeline has a rebuild you did not ask for there).
- **Cause:** the rebuild that follows the save went to whichever agent's sheet was open when the save answered, with that sheet's "save the conversation first" box.
- **Fix:** rebuild the first agent. Since v2.168.0 the rebuild goes to the agent that was saved, with the box as it was when you pressed the button, and the question names the agent.
- **Fixed in:** `v2.168.0`
- **Code:** `web/index.html` — `switchProfile`, `saveImagePin`, `savePeers`

### The model button is greyed out ("Apply the source change first (Use this, above), then pick a model") on an agent whose source you did not change
- **Check:** in an earlier agent's AI tab you picked another source and closed the sheet without Use this; reloading the page makes the button work again.
- **Cause:** opening another agent's sheet showed its own source again, but kept the button off from the earlier, unapplied choice.
- **Fix:** reload the page, or pick the agent's own source in the menu again. Since v2.168.0 each sheet opens with the button on.
- **Fixed in:** `v2.168.0`
- **Code:** `web/index.html` — `prepareEdit`, `onEditProfileChange`

### An agent does not answer, but its Checks name its new AI source and show no refusal (the switch is not rebuilt yet)
- **Check:** the agent's page still offers a rebuild for its source switch; its Usage or event log shows 429 refusals (or failed calls) on the old source; its Checks name the new source.
- **Cause:** until a rebuild, the container still calls the source it was built with, but the Checks' AI-source line read the newly saved one, which it has never called.
- **Fix:** upgrade; the line now reads the source the container runs. Rebuild the agent to apply the switch.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/health.ts` — `aiSourceHealth`

### An AI source shows "rate-limited" again right after one of its agents was moved to another source
- **Check:** Settings → AI sources shows the old source limited since a refusal that was followed by a successful call on that same source (its Usage chart has answered calls after the refusal); the agent was switched to another source after that.
- **Cause:** the source's status compared every refusal it had with successes only from agents still on it, so moving the agent away took its later success with it.
- **Fix:** upgrade; a source keeps the successes made on it, whichever source the agent is on now. Otherwise the warning ends by itself when the limit's window passes (5 hours for a Claude plan, 15 minutes for an API key).
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/sourceUsage.ts` — `summarizeSourceUsage`; `src/store/store.ts` — `lastOkOn`

### `hatchabot switch-source --agents "$LIST"` switched every agent when the list was empty
- **Check:** the command said "switched N agent(s)" for all of yours, and the `--agents` value it was given was empty or only commas and spaces (a script's selection that matched nothing).
- **Cause:** an empty list was sent as "no list", which the server reads as every agent of yours.
- **Fix:** upgrade; an `--agents` that names nobody is refused before anything changes. Leave `--agents` out to mean all. Switch the agents that should not have moved back with `hatchabot switch-source --to <their source> --agents …`.
- **Fixed in:** `v2.168.0`
- **Code:** `src/cli.ts` — `agentsFilter`; `src/api/routes.ts` — `'/v1/ai-profiles/:id/adopt-agents'`

### `hatchabot adopt` put the new agent on a source other than your ⭐ default
- **Check:** ⚙ Settings → AI sources has the ⭐ default below another source; the adopted agent's AI tab names the source at the top of the list; no `--profile` was given.
- **Cause:** adopt took the first source in the list, not the default, unlike `hatchabot create`.
- **Fix:** upgrade; adopt picks the ⭐ default as create does (`--profile` still chooses). Move an agent adopted onto the wrong source on its AI tab, then rebuild it.
- **Fixed in:** `v2.168.0`
- **Code:** `src/cli.ts` — `pickProfile`

### `hatchabot create --profile <name>` or `switch-source --to <name>` used another account's source, or another model, with the same name
- **Check:** `hatchabot sources` lists two sources with that name (a shared one, for example); the agent's AI tab names the other one. After `switch-source` with no `--agents`, every agent of yours moved onto it.
- **Cause:** `--profile` and `--to` took the first source with the name. `switch-source --agents` likewise took the first agent whose name matched, even when another agent's whole id was given.
- **Fix:** upgrade; a name two sources (or two agents) share is refused with nothing changed, and an id picks one. Move an agent that landed on the wrong source on its AI tab (or `hatchabot switch-source --to <id> --agents <agent>`), then rebuild it.
- **Fixed in:** `v2.171.0`
- **Code:** `src/cli.ts` — `pickProfile`, `matchAgent`, `'switch-source'`

### A save was refused, but part of it changed anyway (an AI source's model, the manager's file limit)
- **Check:** the save answered with an error (for example "Only an Anthropic source can back the management assistant", "can't be shared", "Only the server owner sets the default AI source", or "The manager has no browser"), yet the AI source's default model, or the manager's file-size limit sent with it, changed.
- **Cause:** those checks ran after the first fields of the request had been saved.
- **Fix:** upgrade: a refused save changes nothing. Put the field back by hand if it changed, then save the parts that are allowed on their own.
- **Fixed in:** `v2.160.0` (#56, #57)
- **Code:** `src/api/routes.ts` — `'/v1/ai-profiles/:id'`, `'/v1/agents/:id'`

### A class change said "applied", but an agent in it still answers on its old model
- **Check:** the agent's page shows the class's model as waiting (not yet on the runtime), and its Setup log has `model.live_set_failed` at the time of the class change or of putting it in the class.
- **Cause:** a class passes its model to each running member live (`openclaw models set`). When the runtime refused it (its gateway was not answering, for example), the class change still counted that agent as applied, and putting an agent in a class said "model applied".
- **Fix:** upgrade: the class change now lists such agents as still on the old model, and putting one in a class says so. Change the class's model again when the agent answers, or Rebuild the agent, which writes the model from its record.
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/routes.ts` — `applyClassToAgent`, `applyModelToRuntime`, `'/v1/agent-classes/:id'`, `'/v1/agents/:id/class'`

### An agent put in a class fails every message with "request format rejected, HTTP 400" (a class with claude-opus-5-5 on a Claude subscription)
- **Check:** the agent's class sets claude-opus-5-5, its AI source is a Claude subscription, and its OpenClaw is older than 2026.9.7 (Settings → Advanced → Runtime images); its gateway log has `claude_code_version_too_old`.
- **Cause:** choosing that model for the agent itself is refused on such a runtime, but a class gave it without the same check.
- **Fix:** upgrade: a class whose model the agent's OpenClaw cannot run on a subscription is refused for that agent (it shows under the class change's skipped agents). For one already on it, set its model back in Hatchabot, or move it to a newer runtime image.
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/routes.ts` — `subscriptionRuntimeProblem`, `applyClassToAgent`; `src/orchestrator/modelOptions.ts` — `SUBSCRIPTION_MIN_OPENCLAW`

### Every message fails with "request format rejected, HTTP 400" after clearing an agent's model, giving it a class with only a source, or pinning it to an older image
- **Check:** the agent is on a Claude subscription source whose default is claude-opus-5-5 (or it is pinned to that model), it now runs OpenClaw older than 2026.9.7 (Settings → Advanced → Runtime images), and its gateway log has `claude_code_version_too_old`. Just before, its model was cleared (back to the source's default), it was given a class that sets only an AI source, or its image was pinned without changing its model.
- **Cause:** each way of changing an agent checked only the part it changed. Choosing the model itself was refused on such a runtime, but clearing a pin did not check the default it fell back to, a class with only a source skipped the check a source switch makes, and an image pin did not check the model the agent runs.
- **Fix:** upgrade: every change checks what the agent will run once it is stored (its source, model and image together) and refuses with the reason; a class with only a source drops a pin the new runtime cannot use, as a source switch does. For an agent already failing, pick a model its runtime accepts on its AI tab, or give it a newer runtime image.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `finalModelCheck`, `modelChoiceProblem`, `applyClassToAgent`, `'/v1/agents/:id/model'`, `'/v1/agents/:id'`

### "Switch these agents" dropped a model you had just chosen for one of them
- **Check:** you chose a model for an agent while "Switch these agents" (or "Migrate all") was moving several agents to another source, the new source offers that model, and after the switch the agent follows the new source's default; its model ledger shows your choice and then the switch clearing it.
- **Cause:** the switch decided whether to drop each agent's pin from the agent as it read it before the batch began, so a pin set while earlier agents switched was dropped as the old one would have been.
- **Fix:** upgrade: the pin is read when the agent's switch is written, and one the new source offers stands. Until then, choose the model again after the switch.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `switchAgentToSource`, `sourceSwitchRuntime`

### A class change said every agent took its model, but one that was busy still answers on its old model
- **Check:** the class change answered with nothing pending, yet the agent's page shows the class's model as waiting, and at that time the agent was busy (a backup, a snapshot, a move). Its Setup log has `model.apply_deferred`.
- **Cause:** a busy agent's model is only stored, to be applied later, and the class change counted that as applied.
- **Fix:** upgrade: such an agent is listed as still on its old model. Change the class again once the agent is free, or Rebuild it, which writes the model from its record. One that was being rebuilt is counted as applied: the rebuild, or a model change right after it, puts the class's model on. If neither does (the rebuild failed), its timeline says so and its class's row counts it as still on an old model. One whose model waits for a rebuild it is owed (a source switch, a rebuild due at its next start, or the new image its class's model needs) is counted apart, as "waiting for a rebuild".
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `applyClassToAgent`, `applyModelToRuntime`, `publicAgent`, `modelWaitsImage`; `web/index.html` — `renderClassList`

### Two class changes close together leave some of its agents on the earlier settings
- **Check:** the class shows what you saved last, but an agent in it runs the model from the change before (its page and `openclaw models status` agree on the older one). Or an agent put in the class just as the class was changed has the class's earlier model. The changes were saved moments apart (the page saves each field as it is picked), and the first set a memory cap, which takes a moment per agent.
- **Cause:** a class change applies to its agents one at a time, and two changes applied at once. The earlier change, still waiting on a memory update, went on to write its own model over the later change's. An agent joining the class meanwhile was not yet one of its agents, so the later change passed it by.
- **Fix:** upgrade, then save the class again. Changes to one class (an edit, its deletion, an agent joining or leaving) now run one after another: each starts once the one before has written every agent's record, reads the class as that one left it, and says everything it did. The checks that ask an agent's machine (an image pin, the runtime a model needs) are made before that, never while the change holds the class, and are used only while the class and the agent are still as they were checked (checked again otherwise; after three tries the change is refused with nothing written: "The class or its members kept changing while this applied"); the class and its agents' records are written together, so another change never reads the class before its agents have it; the containers (a model, memory limits) are changed after it, six agents at a time, each agent's in its own turn, which puts on what is stored when it comes. An agent slow to answer or to take a model, or on a runner asleep, no longer holds up another change of the class (a join answers meanwhile), and the last change saved is the one its container ends up with. An agent whose own model, source or image was changed while an edit was applying keeps that change: the edit lists it ("keeps that change"), and when it no longer runs what the class now sets it leaves the class there and then ("it left the class"; `class.detached` in its timeline) rather than stay in it on the class's old settings. A model Hatchabot wrote on its own (a budget's switch to a cheaper model and back, a source's new default holding what an agent runs) is not the agent's change: the edit applies to it as to the rest, and an agent on a budget's cheaper model stays on it, keeps its class meanwhile (a later change of its image does not take it out), and gets the class's new model back when the budget's switch ends, a class change made while that switch was being applied included. Leaving a class with no memory limits of its own does not touch the container's limits, so a model change on a runner asleep answers at once. The change answers at once and says so (`classDetached: 'pending'`; "may leave a class" after "Switch these agents"): whether it leaves is decided once the edits of its class under way (checking or writing its agents) are done, and only those; another agent joining or leaving the class does not make it wait. One whose own model was set while an edit moving its class's source or image checked it leaves the class the same way ("its own model was set while this was checked"). A change made then that looks like leaving the class only because the edit has not reached the agent yet (a source's new default) waits for the edit, and the agent stays in. One taken out of the class meanwhile is no longer one of its agents, and the change leaves it alone. One changed while it joined a class keeps the change too, and the join is refused ("changed while this applied"); a join that waited while its old class was deleted goes ahead, and so does one whose old class's edit wrote the agent meanwhile (checked again). A class's memory limits go only on agents still in it, and a member on a machine that is gone is named ("its machine is not known here") while the others still get them.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `inClassQueue`, `classStep`, `'/v1/agent-classes/:id'`, `checkClassFor`, `writeClassEdit`, `applyClassToAgent`, `classModelOn`, `changedSince`, `classWrote`, `classChangedThrice`, `classEditsUnderWay`, `detachClassIfDrifted`, `'/v1/agents/:id/class'`, `applyCurrentLimits`; `src/store/store.ts` — `setAgentClassIf`, `setAgentModel`, `setCheaperPauseFrom`; `web/index.html` — `updateClass`

### Clearing a class's model from a script or the API answers 500
- **Check:** `PUT /v1/agent-classes/<id>` with `"model": null` (or `"name": null`) answers HTTP 500 and changes nothing.
- **Cause:** null was let through as "clear it", then read as text.
- **Fix:** upgrade: `"model": null` clears the class's model, and `"name": null` is refused with "A class needs a name." Until then, send `"model": ""` to clear it.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `'/v1/agent-classes/:id'`

### Switching an agent's AI source while its move or rebuild waits for you lets the operation go on with the new source
- **Check:** the agent has a held or interrupted operation (its page and Alerts say "Choose what to do"), and its AI source was changed afterwards on its AI tab or by giving it a class with a source.
- **Cause:** "Switch these agents" refused such an agent, but a switch of one agent or a class only checked whether it was busy, not for an operation waiting on disk.
- **Fix:** upgrade: the switch is refused until the operation is settled on its page. If it already happened, settle the operation, then set the source you want and rebuild the agent.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `operationRefuses`, `applyClassToAgent`, `'/v1/agents/:id'`


### After changing a Claude plan source's default model and switching agents to it, some of them fail every message with "request format rejected, HTTP 400"
- **Check:** the new default is claude-opus-5-5, the source is a Claude subscription, and the failing agents run OpenClaw older than 2026.9.7 (Settings → Advanced → Runtime images); their gateway logs have `claude_code_version_too_old`.
- **Cause:** "Change the default, and switch these agents" moved every ticked agent without the runtime check a class model or a single agent's model gets.
- **Fix:** upgrade: a ticked agent whose runtime is too old keeps the model it runs, and the message says which ones were not switched and why. For one already moved, set its model back in Hatchabot, or give it a newer runtime image first.
- **Fixed in:** `v2.169.0`
- **Code:** `src/api/routes.ts` — `'/v1/ai-profiles/:id/apply-default-model'`, `subscriptionRuntimeProblem`

### On a shared Claude plan source, my agent fails every message with "request format rejected, HTTP 400" after the source's owner changed its default
- **Check:** your agent follows the shared source's default (no model of its own on its AI tab), the source is a Claude subscription, the new default is claude-opus-5-5, and your agent runs OpenClaw older than 2026.9.7; its gateway log has `claude_code_version_too_old`.
- **Cause:** v2.169.0 held back the source owner's own agents whose runtime was too old for the new default, but another account's agents that follow the default moved with it unchecked.
- **Fix:** upgrade: such an agent is kept on the model it runs (pinned to it), and the source's owner is told how many other accounts' agents were kept, without their names. For one already moved, pick its earlier model on its AI tab, or give it a newer runtime image.
- **Fixed in:** `v2.170.0`
- **Code:** `src/api/routes.ts` — `'/v1/ai-profiles/:id/apply-default-model'`, `subscriptionRuntimeProblem`; `web/index.html` — `applyModelToSelected`

### A Claude source's model menu leaves out models the newer agents on it can run
- **Check:** the source's agents run different runtime images (one on a runner, or one pinned to an older image); `openclaw models list --provider anthropic --all` in the console of the agent on the newest image lists the missing model.
- **Cause:** the menu came from the first running agent found on the source; one on an older image has a smaller catalog, and its list pruned the menu (and flagged the missing models as stale) for every agent on the source.
- **Fix:** upgrade: the agent on the newest OpenClaw is asked, and the answer says which version it came from. On an older version, stop or update the agent on the old image while you pick the model.
- **Fixed in:** `v2.169.0`
- **Code:** `src/api/routes.ts` — `'/v1/ai-profiles/:id/available-models'`; `src/orchestrator/runtimeModels.ts` — `runtimeModels`

### A Claude source with more than twelve running agents still leaves models out of its menu
- **Check:** more than twelve running agents use the source, and the one on the newest runtime image is not among the first twelve on the home screen; the source's model list names an older OpenClaw version than that agent runs.
- **Cause:** only the first twelve running agents were looked at before the newest was picked.
- **Fix:** upgrade: every running agent's version is read (one listing of each machine's containers, kept for 20 seconds and listed again once when it lacks one started since, that second listing kept as long, so a container that has exited is not listed again on every look; or, where that listing fails, the first twelve agents inspected; an agent on a machine not known here is left out rather than failing the menu), and the newest is asked for its models.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `'/v1/ai-profiles/:id/available-models'`; `src/providers/localDockerProvider.ts` — `openclawVersions`


### A class saved without complaint, but giving it to an agent fails: the model "isn't one of this source's models"
- **Check:** the class has an AI source of its own and a model that source's menu does not list (or the source is a local model server).
- **Cause:** a class's model was only checked against its source when the class was given to an agent, not when it was saved.
- **Fix:** upgrade: the class is refused when it is saved, with the reason. For one saved before, edit the class's model (or add the model to the source's switchable list).
- **Fixed in:** `v2.169.0`
- **Code:** `src/api/routes.ts` — `'/v1/agent-classes'`, `modelOverrideProblem`

### An agent answers on a model you picked earlier, not the one you picked last
- **Check:** the agent's page shows the model you picked last, but `openclaw models status` in its console names the one before; both changes said they applied live.
- **Cause:** two live model changes ran side by side, and the older one's `models set` finished after the newer one's.
- **Fix:** pick the model again. Since the fix live model changes for one agent run one at a time, each applying the model stored when its turn comes.
- **Fixed in:** `v2.171.0`
- **Code:** `src/api/routes.ts` — `applyModelToRuntime`, `applyModelNow`

### Settings → AI: a default model chosen but not saved goes back by itself, then Save says "Saved"
- **Check:** open a source, pick another default model or add a switchable one, and wait about half a minute without pressing Save: on an older release the row snaps back to the saved values, open drawers close and a revealed credential hides.
- **Cause:** the poll's usage figures redrew every row from the stored source, so Save then sent the old values and reported success.
- **Fix:** upgrade: the poll updates only the usage line, and any other redraw keeps an unsaved edit. Closing Settings without Save still drops it. On an older release, press Save right after choosing, and check the value after.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `loadSourceUsage`, `renderAiList`, `aiRowEdits`

### Settings → AI: ⟳ Sync said "added" a model, and Save dropped it again
- **Check:** you removed a switchable model without saving, then pressed **⟳ Sync models** (or opened Settings as the list of models arrived). The toast names a model added or cleaned, but the row does not show that, and after Save the source lacks it, or has the cleaned one back.
- **Cause:** an unsaved edit to the list was kept as the whole list, so it replaced what the server had just changed.
- **Fix:** upgrade: the edit is what you added and what you removed, put on the server's list as it is now. On an older release, press Save before Sync.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `aiRowEdits`, `renderAiList`, `syncModels`

### After inviting someone, a second AI source is shared with every account
- **Check:** Settings → AI shows **Shared** on a source you never ticked, and the time matches an invitation made with **Share my AI source with them** ticked while another source of yours was already shared.
- **Cause:** the invitation shared your first source that was not yet shared, without asking whether one already was, so each later invitation could open up one more. A refused share, or having only a machine login, said nothing.
- **Fix:** upgrade, then untick **Shared** on the source you did not mean to share (agents on other accounts keep it until switched). An invitation now shares nothing when a source the new account can use is already shared, names the source when it does share one, and says so under the link when none could be. A machine login shared under an older release does not count: it never runs another account's agent.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `addAccount`, `shareSourceForInvite`

### Settings → AI: the Shared box goes back, Save does nothing, or New token does nothing, with no message
- **Check:** open **Add another AI source**: on an older release the reason is in the red line at the foot of that drawer. Machine-login sources, for one, are refused for sharing by accounts that do not own the machine.
- **Cause:** these controls wrote their errors into that drawer, closed and, for New token, on another tab.
- **Fix:** upgrade: the error shows on the source's own row with a toast, and New token has its own line on the Security tab.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `aiRowSay`, `shareAiProfile`, `saveAiProfile`, `newCliToken`

### Move agents here: some agents did not move, and the reason flashed past
- **Check:** after **Move agents here…**, an agent you ticked still shows its old source under Settings → AI or on its AI tab.
- **Cause:** the summary and each skipped agent were separate toasts, each replacing the last, and the dialog closed at the same moment.
- **Fix:** upgrade: when any agent is skipped the dialog stays open, with the summary, each skipped agent and its reason, and only the agents still to move, and it keeps your choices for a retry. If you pressed Cancel meanwhile it stays closed, and a toast says what was skipped. If you reopened it, for this source or another, the move answers in a toast and the open list drops what moved, keeping your ticks. On an older release, move the agent alone to read its reason.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `moveAgentsApply`, `moveAgentsToSource`, `moveSourceRedraw`

### An agent's AI source is gone: switched to a source while it was being deleted
- **Check:** the agent's page names no AI source, or a rebuild fails because its source cannot be found, and the source it was switched to was deleted at about the same time.
- **Cause:** deleting a source checked that no agent used it, then deleted its key, and only then the source. An agent switched to it during the key's deletion kept a source that no longer existed. The other way round, a switch (an agent's AI source, Move agents here, a class that brings its source) or an import (Restore, a move from another Hatchabot) that was checking the agent's runtime, applying its memory limit or reading the file when the source went also went ahead.
- **Fix:** switch the agent to another source. Since the fix, the source is gone the moment it is found unused, and a switch to it is refused ("That AI source was deleted meanwhile") with nothing changed. A switch (an agent's AI source, Move agents here, a class) holds the source until the switch is stored, even if the page that asked was closed; from then on the agent is on it, and a delete says it is in use. While it does, for ten minutes at most, deleting the source is refused with "An agent is switching to it; try again in a moment.", or "Still in use by …" when an agent already uses it. An agent's settings saved with a source switch are stored all at once: when the switch is refused or the save fails, none of them is kept, nothing follows from them or is logged for them, and a memory limit already given to its container is put back as stored. An import is not held, since a large one takes minutes: one whose source is gone by the time its agent is written is refused (409, "That AI source was deleted meanwhile") with no agent made, and so is a template. An agent deleted during its switch is said to be deleted ("It was deleted."), not its source, and one deleted while any of its settings were being saved has none of them stored. A source switch, a class or Move agents here judges each agent as it is when it writes it: one busy by then is skipped as busy, and one moved to a runner meanwhile is not put on this machine's login (an agent's own switch is refused, as it would have been up front).
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `'/v1/ai-profiles/:id'` (DELETE), `'/v1/agents/:id'` (PATCH), `'/v1/agents/restore'`, `'/v1/agents/import'`, `holdSource`, `withSourceHold`, `switchAgentToSource`, `applyClassToAgent`, `applyCurrentLimits`; `src/store/store.ts` — `setAgentAIProfile`, `insertAgentOnSource`, `SourceGoneError`; `src/orchestrator/transfer.ts` — `importAgent`; `src/orchestrator/template.ts` — `importTemplate`

### On OpenClaw 2026.9 an agent can't select some of its source's models (Fable, Opus 5.5 or Sonnet 5.5 missing from /model)
- **Check:** the agent runs OpenClaw 2026.9.x. In its console, `openclaw models list` shows fewer models than its AI source lists, and `openclaw config get agents.defaults.modelPolicy --json` has an `allow` list without the missing ones. A rebuild does not change it.
- **Cause:** from 2026.9, OpenClaw offers an agent only the models on `agents.defaults.modelPolicy.allow`. Its upgrade of an older volume filled that list once, from the models the agent had then. Hatchabot wrote only `agents.defaults.models`, so models added to the source later were never allowed. A model change from the app set the model anyway, so the agent could run a model its own picker did not show.
- **Fix:** upgrade, then rebuild the agent, change its model in the app, or save its source's model list (each writes the allowlist from the source). Before the fix, set it by hand in the agent's console to the source's models, each with `anthropic/` in front: `openclaw config set agents.defaults.modelPolicy.allow '["anthropic/claude-sonnet-5","anthropic/claude-opus-5-5"]' --replace`, listing every model you want, then check with `openclaw models list`. Older OpenClaw (2026.7 and earlier) has no allowlist and refuses the key; nothing is written there.
- **Fixed in:** `v2.179.1`
- **Code:** `src/openclaw/configWriter.ts` — `switchableModelCommands`, `hasModelPolicy`, `buildConfigCommands`; `src/orchestrator/provision.ts` — `switchableModelsFor`; `src/api/routes.ts` — `applyModelNow`, `applyModelToRuntime`

### A model added to an AI source does not show in a running agent's model picker until it is rebuilt
- **Check:** the source's list in Settings → AI sources has the model; the agent's `/model` menu, or `openclaw config get agents.defaults.models --json` in its console, does not.
- **Cause:** saving a source's list only stored it. The agent's own list was written when it was built.
- **Fix:** upgrade. A saved list is now written to each of the source's agents at once, running or stopped, one agent after another. An agent whose model is about to change (its pin was dropped from the list, or a source switch waits) gets the list with the rebuild that change waits for, which its page shows. Its Setup log shows `model.list_set`, or `model.list_set_failed` when the write failed; then it gets the list at its next rebuild.
- **Fixed in:** `v2.179.1`
- **Code:** `src/api/routes.ts` — `'/v1/ai-profiles/:id'` (PATCH), `pushModelList`, `applyModelListNow`, `runtimeVersionOf`

### A Claude source's "Add a model" menu offers the same model twice (`claude-haiku-4-5` and `claude-haiku-4-5-20251001`), or ⟳ Sync fails on a long list
- **Check:** the menu shows ids that end in a date beside the same model without one. A source's list holds at most 16 models, its default among them; a Sync that would pass 16 was refused.
- **Cause:** the menu listed every id the agent's runtime catalogues, and some models are catalogued twice, with and without a date. Each took a place on the list. The editor did not say when the list was full, and Sync added every model it found.
- **Fix:** upgrade. The menu offers each model once (the undated id where there is one), says when the list is full, and Sync adds what fits and names the rest. A dated id already on a list stays until you remove it; remove the duplicate by hand to free its place.
- **Fixed in:** `v2.179.1`
- **Code:** `src/orchestrator/modelOptions.ts` — `foldDatedIds`; `src/api/routes.ts` — `'/v1/ai-profiles/:id/available-models'`; `web/index.html` — `renderExtras`, `syncModels`, `MAX_SOURCE_MODELS`

## Telegram, Discord and Slack

### A new agent has no Telegram bot, and no Telegram link to tap
- **Check:** the agent was made in the app (New agent, a clone, a template, an app from a repo) or drafted by the Hatchabot agent, on v2.176.0 or later, and **Use Telegram** was not ticked; its Telegram tab offers **Connect** and its tile has no Telegram mark. Its results, a scheduled task's among them, arrive in its console conversation (the red dot on its icon).
- **Cause:** a setting, not a fault. Telegram is off unless it is asked for: the web console is how most agents are talked to, and a new agent no longer takes a bot from the pool unless you tick it; one the Hatchabot agent drafts for you starts without one too. The command line keeps its old default (`hatchabot create` takes a bot; `--no-telegram` goes without), and so does the API when a request does not say. The Hatchabot agent was always made without a bot; its own Telegram (for alerts on your phone) is still attached from its Telegram tab.
- **Fix:** on the agent's Telegram tab, **Connect** (instant from a spare bot in Settings → Messaging, or paste a BotFather token). For the next agent, tick **Use Telegram** in the New agent form.
- **Fixed in:** `v2.176.0`
- **Code:** `web/index.html` — `agentTelegramChanged`, `createAgent`, `cloneAgent`, `importAgentFile`, `appGo`; `src/mgmt/broker.ts` — `create_agent` (sends `telegram: false`)

### Settings has no Telegram, Discord or Slack tab
- **Check:** ⚙ Settings shows a **Messaging** tab between Classes and Connections, and no tab named Telegram, Discord or Slack.
- **Cause:** on a release after v2.175.0 the three are one tab, Messaging, with every control as it was. From v2.176.0 to v2.178.1 it stacks Telegram's spare bots, then Slack's apps, then Discord's bots, each under its heading. Since v2.178.2 it shows one of them at a time, picked from the **Show** list at its top. Older notes and messages that say Settings → Telegram (or Discord, Slack) mean that part of it.
- **Fix:** open Settings → Messaging and pick the app in **Show** (before v2.178.2, scroll to it). A link to the old tab opens Messaging on that app.
- **Fixed in:** `v2.176.0` (one tab), `v2.178.2` (one app at a time)
- **Code:** `web/index.html` — `V2_SETTINGS`, `v2SettingsShown`, `showTab`

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

### An agent upgraded from OpenClaw 2026.7 shows no knock card, or someone let in is still not admitted
- **Check:** the agent runs 2026.9; `credentials/telegram-pairing.json` (or a `-allowFrom.json`) is still on its volume next to `state/openclaw.sqlite` (Files, or `docker run --rm -v <volume>:/v alpine ls /v/.openclaw/credentials`).
- **Cause:** OpenClaw's 2026.9 migration moves those files into its database and removes them, but leaves one it cannot read or place. Hatchabot read and wrote that file in preference to the database, so the database's requests were hidden and an approval went where 2026.9 does not look.
- **Fix:** upgrade: requests are read from both stores (the database first), and a deny or a grant writes both. The left-over file can be deleted by hand once it is empty.
- **Fixed in:** `v2.169.0`
- **Code:** `src/orchestrator/claim.ts` — `pairingListShell`; `src/orchestrator/members.ts` — `denyPairing`, `grantChannelAccess`

### `hatchabot pairing` stops with "Not found" and lists no requests, although someone is waiting
- **Check:** `hatchabot pairing <agent>` for the agent with the knock lists it; the fleet has a running agent with no chat app (web chat only) or one shared with you as a member.
- **Cause:** the bare command asked every running agent, and an agent without a chat app (or not yours) has no pairing requests to read: its "Not found" stopped the whole command.
- **Fix:** upgrade; the command asks only running agents of yours on a chat app. Until then, name the agent: `hatchabot pairing <agent>`.
- **Fixed in:** `v2.168.0`
- **Code:** `src/cli.ts` — `pairingTargets`; `src/api/routes.ts` — `'/v1/agents/:id/pairing'`

### Two agents answer on one bot, or messages to a bot go missing
- **Check:** two running containers carry the same bot token (the bot was moved, swapped, or is also used by a hand-built OpenClaw).
- **Cause:** two pollers on one Telegram bot take each other's messages, silently. Before v2.68.0 a bot removed from an agent stayed in its config on the volume.
- **Fix:** upgrade and rebuild the agent that should no longer have the bot. When reusing a bot from another OpenClaw, disable it there first.
- **Fixed in:** `v2.68.0`
- **Code:** `src/openclaw/configWriter.ts` — `channels.telegram.enabled`

### The Bot pool lists a bot as spare though an agent runs on it, and Remove deleted that agent's token
- **Check:** the bot is the one a just-archived (or deleted) agent had pasted; another agent was created at the same moment and now uses it; after Remove, that agent fails its next rebuild with a missing secret.
- **Cause:** a pasted bot is parked in the pool before it is released; a create could lease it in between, and the release then cleared that new lease.
- **Fix:** upgrade: a release for a departing agent leaves another agent's lease alone (`pool.release_skipped` in the log). For an agent already affected, change its bot (Messaging → Change bot).
- **Fixed in:** `v2.168.0`
- **Code:** `src/channels/telegramPool.ts` — `release`

### An archived agent still has its Discord or Slack bot, and Archive again says it is already archived
- **Check:** Hatchabot restarted while the agent was being archived; its Messaging tab still lists Discord or Slack, and the bot is not in the pool.
- **Cause:** parking the Discord and Slack bots was the archive route's own last step, so the archive's finish after the restart did not do it.
- **Fix:** upgrade: the archive's finish parks them, a restart's included. For an agent already affected, unarchive it and archive it again.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/archive.ts` — `finishArchive`, `parkOtherChannels`; `src/api/routes.ts` — `parkArchivedChannels`

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
- **Check:** the agent's sheet asks for a Telegram bot token; Settings → Messaging → Telegram shows no spare bot.
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

### An app's API key or password shows in plain text in the "tests failed" error or the agent's log
- **Check:** the app's settings include a secret field (its `hatchabot.json` marks it `"secret": true`), and its tests print the value they were given; the error from Install or Update, or the app's pending error, shows it.
- **Cause:** the last lines of the tests' output were put in the error, the event log and traces as they were.
- **Fix:** upgrade: every secret field's value is replaced by `••••••` in the tests' output before it is kept anywhere. A value shorter than four characters is not masked. Change a key that was already shown, and stop the app's tests printing it.
- **Fixed in:** `v2.169.0`
- **Code:** `src/orchestrator/apps.ts` — `installRelease`, `secretValues`, `maskSecrets`

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

### Installing an app is refused "on the same account", though the other agent's app uses another mailbox
- **Check:** the agent the message names has the account attached (its settings → Connections), but its app's config (`config.json` under `~/.openclaw/apps/<app>/data` in that agent) names another address.
- **Cause:** before v2.170.0 the check counted every live agent with the account attached and the same app, not the account its app was configured with.
- **Fix:** upgrade: the check reads the other agent's app config and refuses only when it names that account. An agent that is not running, or whose config cannot be read, still counts. The dialog still warns by attachment, so confirm there when the other copy uses another address. On an older version, confirm in the dialog (`allowShared`), or detach the account from the other agent.
- **Fixed in:** `v2.170.0`
- **Code:** `src/api/routes.ts` — `sharedAppConflicts`, `appAccountsOf`

### An app was installed and said "installed and running", but it cannot use the Google account picked for it
- **Check:** the account shows attached in the agent's settings → Connections, the app's commands fail to sign in to Google, and the agent's log has `connection.attached` from that install.
- **Cause:** before v2.170.0 "Run an app" went on with the install when attaching the account answered that it was attached but could not be set up in the agent.
- **Fix:** upgrade: the dialog stops, says what failed, and installs nothing. Press Install again; if it fails again, connect the account again in ⚙ Settings → Connections. On an older version, restart the agent (the account is set up as it starts) or detach it and attach it again.
- **Fixed in:** `v2.170.0`
- **Code:** `web/index.html` — `appGo`, `appAttachProblem`

### A new agent made from an app repo is on the wrong AI source
- **Check:** "New agent from a repo" was used without touching its AI source box, and the ⭐ default source is not first in ⚙ Settings → AI sources.
- **Cause:** before v2.170.0 the app form preselected nothing, so the first source in the list was used (perhaps a paid API key), where regular creation and the CLI use the ⭐ default.
- **Fix:** upgrade: the form preselects the ⭐ default. Move an agent made on the wrong one from its settings (its AI source).
- **Fixed in:** `v2.170.0`
- **Code:** `web/index.html` — `appRead`

### A new agent made from an app repo has "{app_dir}" or "{env}" in its instructions (SOUL.md)
- **Check:** the app's `hatchabot.json` has a `chat` with placeholders, and the agent's SOUL.md (its settings → Files) shows them as written.
- **Cause:** before v2.170.0 the page and `hatchabot app create` copied `chat` into the new agent as it was; only the app's tests and tasks had their placeholders filled in.
- **Fix:** upgrade: a new agent's chat has `{app_dir}`, `{data_dir}`, `{agent}`, `{name}` and `{env}` filled in, as its tasks do. The text is written once, when the agent is made: an app update does not change it. For an agent made before, edit its SOUL.md.
- **Fixed in:** `v2.170.0`
- **Code:** `src/orchestrator/apps.ts` — `appChat`, `appVars`; `src/cli.ts` — `app create`; `web/index.html` — `appGo`

### `hatchabot app create` asks for a setting whose default the app already gives
- **Check:** `hatchabot app inspect <dir|url>` lists the setting as required with a default, and `app create` stops with "… needs: key=…" before making the agent.
- **Cause:** before v2.170.0 the CLI asked for every required setting not typed, ignoring defaults; installing takes the default.
- **Fix:** upgrade: the CLI judges what is missing by the rule installing uses. On an older version, pass the default as `key=value`.
- **Fixed in:** `v2.170.0`
- **Code:** `src/cli.ts` — `app create`; `src/orchestrator/apps.ts` — `mergeConfig`

### An app setting marked secret shows in an install error, or in the operation and event records
- **Check:** the app's `hatchabot.json` marks the field `"secret": true`, and a value of the wrong type (an email field given text that is not an address) was given; the error said "must be … (got …)" with the value.
- **Cause:** before v2.170.0 the check of a value's type quoted it in its error, secret or not, and the error was kept as the operation's outcome and in its event.
- **Fix:** upgrade: a secret field's value, or its default, is never quoted, and any secret value given is masked in an install's error before it is kept. Change a key or password already shown.
- **Fixed in:** `v2.170.0`
- **Code:** `src/orchestrator/apps.ts` — `mergeConfig`, `installRelease`, `maskSecrets`

### An app runs with an empty list for a required setting (no recipients)
- **Check:** the app's config (`config.json` under `~/.openclaw/apps/<app>/data` in the agent) has `[]` for a field its `hatchabot.json` marks required with `"type": "list"`, and the value before was text such as `, ,`.
- **Cause:** before v2.170.0 a kept value was checked for being blank before it was turned into a list, so text with only commas became `[]` and was accepted.
- **Fix:** upgrade: a kept value is checked after it is turned into its type, so the install or update asks for it. Give it with `key=value`, or in the dialog.
- **Fixed in:** `v2.170.0`
- **Code:** `src/orchestrator/apps.ts` — `mergeConfig`

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

### `hatchabot app inspect`, `app install` or `app create` with a git address says "No folder at …/https:/…"
- **Check:** the address starts with `https://`, `ssh://` or `git@`, and the error names a folder made of the current directory and that address.
- **Cause:** the CLI took every source for a folder and made it absolute from where the command ran, so an address never reached the server as one.
- **Fix:** upgrade; a git address goes as typed. On an older CLI, clone the repo and give its folder, or use the app's "Run an app from a repo".
- **Fixed in:** `v2.168.0`
- **Code:** `src/cli.ts` — `appSourceArg`; `src/orchestrator/apps.ts` — `parseSource`

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

### An app's row stays on "Updating… (tests first)" with the button greyed out
- **Check:** Update, Roll back, Stop app or Try again answered (a toast said what happened), but the App row still shows the pressed button; closing and reopening the agent shows the app as it is.
- **Cause:** after the action the page reads the app again, and before v2.169.0 a failed read (the service restarting, a network blip) left the row as it was, button disabled.
- **Fix:** upgrade: the row then says it could not read the app, with **Read again**. On an older version, close and reopen the agent.
- **Fixed in:** `v2.169.0`
- **Code:** `web/index.html` — `v2LoadApp`, `v2AppUpdate`

### An app task you had turned off stays after Stop app, or runs twice after an Update
- **Check:** `openclaw cron list --all` in the agent's console shows an `<app>-<task>` job that is disabled (left after Stop app), or one disabled beside an enabled one of the same name after an Update.
- **Cause:** before v2.160.0 Hatchabot listed the app's tasks without `--all`, so a disabled one was invisible to Update, Roll back and Stop app.
- **Fix:** upgrade, then Update (or Stop app) again: disabled tasks are listed too and replaced or taken off. On an older version, remove the leftover with `openclaw cron rm <id>`.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/apps.ts` — `appJobs`

### An app task you had turned off runs again after an Update or Roll back
- **Check:** `openclaw cron list --all` in the agent shows the `<app>-<task>` job you had turned off as enabled, with a new id, after an Update or Roll back (a failed one may have said "Its tasks are as they were").
- **Cause:** before v2.168.0 an Update or Roll back replaced the app's tasks with new jobs made switched on, whatever the old ones were; after a failure its put-back did the same, and its check counted only names, so the message said nothing had changed.
- **Fix:** upgrade: a task that was off stays off through an Update or Roll back, and is put back off after a failure; if the agent re-adds it on anyway, the message says "switched on, though you had turned it off: …" instead of "as they were". On an older version, turn it off again on the agent's Schedule tab (or `openclaw cron disable <id>`).
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/apps.ts` — `syncTasks`

### After an app Update, another app's tasks run beside the old ones, and Stop app leaves the old ones running
- **Check:** `openclaw cron list --all` in the agent shows the tasks of two apps (`<old>-<task>` and `<new>-<task>`) while its App row names one, and the `"app"` in the source's `hatchabot.json` is not the one installed.
- **Cause:** before v2.168.0 Update installed whatever app its source now named. A renamed `"app"` scheduled the new app's tasks beside the old app's and recorded them under the old name, so Stop app took off only the new ones.
- **Fix:** upgrade: Update now refuses it ("… is another app (…), so it was not installed as an update") and changes nothing; to replace the app, install it again from the same source (the old app's tasks come off first). On an older version, remove the leftover jobs with `openclaw cron rm <id>`, then Stop app and install again.
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/routes.ts` — `/v1/agents/:id/app/update`, `installFromSource`

### Every app install, update or Stop app says "The agent's scheduled task list is incomplete or malformed"
- **Check:** `openclaw cron list --all --json` in the agent's console has a job with no `name` (one of the agent's own, not the app's), and the message comes back on every try.
- **Cause:** before v2.160.0 every job of the agent had to have an id and a name, even ones that have nothing to do with the app.
- **Fix:** upgrade: only the app's own jobs (`<app>-…`) are checked. On an older version, give the unnamed job a name or remove it.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/apps.ts` — `appJobs`

### After Stop app, the app and its scheduled tasks came back at the next start
- **Check:** the agent was made "from a repo" and its app was then installed by hand (Run an app from a repo, or `hatchabot app install`); after Stop app and a restart of Hatchabot, the App row names the app again and its Setup log shows `app.installed` with no install of yours.
- **Cause:** before v2.170.0 the install that had waited for the new agent stayed recorded after a direct install replaced it, and Stop app did not remove it, so the start installed it again.
- **Fix:** upgrade, then press Stop app again: a direct install now retires the waiting install, and Stop app removes one still recorded.
- **Fixed in:** `v2.170.0`
- **Code:** `src/api/routes.ts` — `/v1/agents/:id/app`, `runPendingApp`; `src/orchestrator/appPending.ts` — `dropAppPending`

### A new agent's app never goes in: its page keeps saying "Installing its app from … once it is running…"
- **Check:** the agent is running, its App row still says it is waiting, and its Setup log has no `app.installed` or `app.install_failed`; either setup finished while the app's repo was being read, or a second request to install was made while the first was still running.
- **Cause:** before v2.170.0 the request judged the agent by its state before reading the repo, so one whose setup finished meanwhile was never started; and a request that finished deleted a newer request saved while it ran (or put its error on it).
- **Fix:** upgrade. On an older version, restart Hatchabot, or make the request again from the agent's page once the first has finished.
- **Fixed in:** `v2.170.0`
- **Code:** `src/api/routes.ts` — `runPendingApp`, `runPendingOnce`, `/v1/agents/:id/app/pending`; `src/orchestrator/appPending.ts` — `dropAppPending`, `onePendingChange`

### A waiting app install fails after Unarchive: a password or key it was given is missing
- **Check:** the agent was archived while a second install from a repo was being prepared for it (Install when ready), the second request said "It was deleted or archived meanwhile, so nothing was saved", and the install that was already waiting fails on a secret field once the agent is back.
- **Cause:** both requests keep a secret field at the same place. The refused one put its own value there and then deleted it, which took the waiting install's value with it.
- **Fix:** give the install its values again (Install when ready on the agent's page). Since the fix, a refused request puts back what was there.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `/v1/agents/:id/app/pending`; `src/orchestrator/appPending.ts` — `stashPendingSecrets`, `pendingSecretRefs`

### Installing an app is refused: "Its app changed meanwhile (another install or update finished)"
- **Check:** another install, update or Stop app of this agent's app finished while this install was still reading its repo.
- **Cause:** from v2.170.0 an install judges the agent's app as it was when it was asked, as an update does: the later change wins and the older request is refused rather than going in over it.
- **Fix:** look at the agent's App row, then install again if you still want this app.
- **Fixed in:** `v2.170.0`
- **Code:** `src/api/routes.ts` — `installFromSource`, `appStillAsWas`

### A scheduled task you had turned off is on again after an app replacement failed ("unchanged")
- **Check:** installing another app in place of the agent's app failed (its tests, say) and said the running app was unchanged, and `openclaw cron list --all` in the agent shows the old app's task you had turned off as enabled, with a new id.
- **Cause:** before v2.170.0 the old app's tasks were put back from its manifest alone, switched on, whether the install failed or a restart cut it off.
- **Fix:** upgrade: the tasks that were off are recorded before they come off and go back on turned off, and the install says so when that cannot be confirmed. On an older version, turn the task off again on the agent's Schedule tab (or `openclaw cron disable <id>`).
- **Fixed in:** `v2.170.0`
- **Code:** `src/api/routes.ts` — `installFromSource`; `src/orchestrator/appOperations.ts` — `putTasksBack`; `src/orchestrator/apps.ts` — `syncTasks`

### A failed app Roll back leaves the agent on the earlier release while its App row names the newer one
- **Check:** the Roll back answered an error, and the agent's `apps/<app>/current` link names the release it went back to while the App row (and its tasks' schedule) still name the newer one; its operation in Activity ended "failed" with nothing to choose.
- **Cause:** before v2.170.0 a switch whose reply was lost was taken as not made, and a failed point-back after the tasks could not be set ended the operation as failed instead of holding it.
- **Fix:** upgrade: a switch is judged from the link itself, and when the release and the record cannot be brought back together the operation waits for your choice (Use the release it went back to, or Stay on the newer). On an older version, run Roll back again, or Update.
- **Fixed in:** `v2.170.0`
- **Code:** `src/orchestrator/apps.ts` — `switchTo`; `src/orchestrator/appOperations.ts` — `appChoices`

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

### Archive said "its bot is back in the pool", but the bot is not in the pool
- **Check:** the agent's bot was one you pasted (not from the pool); its activity says "its bot could not go back to the pool; the token was discarded" (`archive.recycle_failed`) at the archive, and the pool (the machine's Settings → Telegram) does not list the bot.
- **Cause:** the page wrote what should have happened, not what did: parking a pasted bot in the pool can fail (its token could not be read or stored), and the archive goes on without it.
- **Fix:** upgrade: the archive's answer says where the bot went, and the page says that ("its bot @… could not be put back in the pool"). To use the bot again, paste its token into an agent, or add it to the pool.
- **Fixed in:** `v2.178.0`
- **Code:** `src/orchestrator/archive.ts` — `archiveAgent`, `ArchiveOutcome`; `src/api/routes.ts` — `'/v1/agents/:id/archive'`; `web/index.html` — `confirmArchive`

### An unarchived agent hangs in PROVISIONING: "waiting for a bot token"
- **Check:** after Restore (`hatchabot unarchive`), the Setup log ends with "waiting for a bot token" and Settings → Messaging → Telegram shows no spare bot. From 2.142.0 the same situation shows instead as an Alerts line on a running agent: "No Telegram bot was free — it is running in the web app; attach a bot later".
- **Cause:** coming back means leasing a new bot, and none was free. Before 2.142.0 unarchive, clone, derive and template import then parked on the paste-a-token step, though nobody had been asked about Telegram.
- **Fix:** on an older install, `hatchabot skip-telegram <agent>` (or **Continue without Telegram** on its sheet) finishes it web-only, or paste a @BotFather token. From 2.142.0 it goes on web-only by itself; attach a bot when one is free under its settings → Messaging → Telegram (archive or detach another agent to free one, or paste a token).
- **Fixed in:** `v2.142.0`
- **Code:** `src/orchestrator/provision.ts` — `provisionChannelOrGoWebOnly`, `webOnlyIfNoBot`; `src/store/store.ts` — `telegramSkippedForNoBot`; `src/api/routes.ts` — `telegramSkipped`

### @BotFather will not create another bot
- **Check:** count the bots on that Telegram account (@BotFather `/mybots`; Settings → Messaging → Telegram lists the spares).
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

### Two agents answer on one bot after you deleted or archived an agent whose downloaded copy runs elsewhere
- **Check:** the agent was downloaded (or moved by file) while it stood stopped and imported on another Hatchabot; then the stopped original here was deleted or archived, and a new agent here got the same bot (its Messaging row names the same @username as the copy's).
- **Cause:** delete left a pool bot's lease to go back to the pool, and archive parked even a pasted bot, although a copy elsewhere could be answering on it; the next new agent here leased it.
- **Fix:** upgrade; such a bot leaves this machine's pool (a pool bot) or is not parked (a pasted one), without a goodbye through it, unless you delete with "recycle the bot" (`?recycleBot=1`). Already doubled: give the agent here another bot (Change bot) and remove the shared one from Settings → Bot pool.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/archive.ts` — `leaveBotToCopy`, `copyElsewhere`, `archiveAgent`; `src/api/routes.ts` — `bot.not_parked`

### Two agents answer on one Telegram bot after "Change bot", or the new agent's bot gets no messages
- **Check:** the agent's trail has `channel.stop_failed` near `channel.swapped`, or two agents' containers both poll the same `@bot` (Telegram 409 Conflict in the gateway log).
- **Cause:** the swap put a pasted bot back in the pool before the agent stopped, and swapped the row even when the stop failed; a Start could also boot the old container before its rebuild.
- **Fix:** upgrade. Then stop the agent still holding the old bot and rebuild it.
- **Fixed in:** `v2.153.0`
- **Code:** `src/api/routes.ts` — `rebuildAfterHandover`, `'/v1/agents/:id/channel/swap'`

### Discord or Slack: "It answers you now" on an agent that is stopped or rebuilding
- **Check:** the sheet after connecting said **It stays stopped** (or **It restarts now**), and a few seconds later **✓ Linked. It answers you on … now**, while the agent's tile shows it stopped or being rebuilt.
- **Cause:** the sheet watched only whether you were linked. You can be linked before the bot is live, since your identity is already known.
- **Fix:** upgrade: it says **once it is started** or **once it is back up**, and **now** only when the agent is up with no change waiting; a slow older check cannot take back a newer **now**. On an older release, go by the tile, and start the agent.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `chanShowConnected`

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
- **Check:** in Settings → Messaging → Telegram, the bot is leased but its pending name is "Hatchabot (unassigned)".
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

### After unlinking your Discord, an agent still admits it, and unlinking again does nothing
- **Check:** Settings → You said "Unlinked." (before v2.166.0), yet one agent still answers your Discord DMs without asking "That's me". The agent runs on a runner that was asleep, or Docker was down, at the time; the log has `channel.unlink_scrub_failed` for it. Unlink again and it says it has no Discord to unlink (`agents: 0`). Or: two agents knew you under two different Discord ids (you linked another account on one), and the second id still works on its agent.
- **Cause:** the unlink dropped every agent's binding first and then scrubbed the agents' allowlists on their volumes, where the pairing approval lives and survives a rebuild. A scrub that failed was only logged; the binding it needed to retry was gone. And it took one id (the newest binding) and scrubbed that from every agent, so an agent that knew you under another id kept it.
- **Fix:** upgrade, then unlink again. Each agent is now scrubbed of the id it knows, and its binding goes only once the scrub is done; when an agent cannot be reached the reply names it (`unlinked: false`, `failed`) and the rest are done, so unlinking again finishes it when the machine is awake. On an older version, or for an agent that lost its binding already: remove your Discord id from that agent by hand (Access → the member's channels), or rebuild it after removing the approval from `credentials/discord-*-allowFrom.json` on its volume.
- **Fixed in:** `v2.166.0`
- **Code:** `src/api/routes.ts` — `/v1/account/discord`, `allowlistScrubScript`; `src/store/store.ts` — `unbindMemberIdentity`, `memberIdentities`

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

### Reopen for a member (or Add Telegram again) did nothing: the door shut again before they messaged
- **Check:** **Reopen** was pressed (or Telegram attached again) while an earlier 30-minute window for the same person was still running; the agent's timeline shows `claim.window_closed` at the EARLIER window's end, and the agent's config has `dmPolicy` "allowlist" again while the app still showed the window open.
- **Cause:** the two watchers share one stored window per person and chat app. The older one kept its own deadline and, when it ran out, deleted the window and set the door back to allowlist, though the newer watcher was still waiting.
- **Fix:** upgrade. A watcher that finds its window renewed stops without touching it (`claim.window_superseded` in the timeline), and only the latest one closes the window when its own time is up. Until then: press Reopen again once the earlier window's time has passed.
- **Fixed in:** `v2.166.0`
- **Code:** `src/orchestrator/claim.ts` — `claimFirstContact`, `superseded`, `claim.window_superseded`

### "Add someone you know" fails with "UNIQUE constraint failed: memberships.agent_id, memberships.user_id" for a person removed from this agent before
- **Check:** the person was removed from this agent earlier and is a member of another of your agents; pressing Add again fails the same way. Their messages may already be let in, although Members does not list them.
- **Cause:** adding a known person always made a new seat, after writing them into the agent's allowlist; the seat they had before was still there (removed), so the new one was refused.
- **Fix:** upgrade, then press Add again: their old seat is taken up again, linked to the chat app they are known on. Until then, send them an invite: redeeming one takes the old seat up again.
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/members/known'`; `src/store/store.ts` — `reactivateMembership`

### Someone joined with an invite but has no way in: the join page said they were in, with no link, and the invite now says "already used"
- **Check:** the person chose Discord or Slack (or Telegram) on the invite page, and that app was removed from the agent between their opening the page and pressing Join; Members lists them, not linked on any app.
- **Cause:** the join spent the single-use invite and made the seat before it looked for the app they chose; with the app gone there was nothing to link them on.
- **Fix:** upgrade: such a join is refused ("… is no longer on Discord") and the invite stays good for an app the agent is on, after a reload. For someone already stranded: remove them and send a new invite.
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/routes.ts` — `'/v1/join'`; `src/orchestrator/invite.ts` — `redeemInvite`

### A web-chat invite keeps asking for the password: the right one brings the same form back, with no message
- **Check:** the link is at the public address and the account has no second factor, owns an agent, or has a factor not yet given in this browser. In the browser's network tab `/v1/login` answers 200 and `/v1/join` answers 401.
- **Cause:** the public address needs a second factor before a sign-in counts. That refusal is right, but it looked the same as no sign-in at all, so the page showed the form again and said nothing.
- **Fix:** upgrade: the page says what is missing. With a factor: open Hatchabot, give it there, come back and press Join. With none: use a reset link from the owner and add one right after it, or add one at the private address, then open the invite again. The owner can instead let chat-only guests in without one (Settings → Reach it from anywhere), which works only for an account that owns nothing. Without upgrading, the same steps work: nothing but the message was missing.
- **Fixed in:** `v2.173.0`
- **Code:** `web/join.html` — `joinWebAccount`, `postJoin`; `src/api/routes.ts` — `joinForWebChat`, `joiningAccount`; `src/api/publicAccess.ts` — `factorRefusal`, `refuseSession`

### A web-chat invite only offers "Sign in with Google", and someone with a username and password cannot join
- **Check:** this Hatchabot uses Google sign-in with password accounts as well (`HATCHABOT_AUTH=identity` and `HATCHABOT_LOCAL_ACCOUNTS=1`), and the person signs in with a username and password; or they are signed in here already and the page still asks for Google.
- **Cause:** before v2.179.0 the join page chose its sign-in by the install's mode alone: on a Google install it offered only Google, though Hatchabot would have taken their password account or the session they already had.
- **Fix:** upgrade: the page offers the password form where password accounts sign in, and **Join as …** when the browser is signed in here already. Or skip the link: in the agent's **Sharing** → **Members**, pick them from **Share with someone on this Hatchabot…** and the agent is on their home screen at once. Without upgrading, give them a Google account to sign in with, or add them on a chat app first and then use **Allow web chat…** in Members.
- **Fixed in:** `v2.179.0`
- **Code:** `web/join.html` — `initWebChat`, `setWebMode`, `joinWebAccount`; `src/api/routes.ts` — `'/v1/invites/:code'`, `joiningAccount`, `webChatPeople`

### Signed in with a password account named with my email, I don't see the agents of my Google sign-in (or the other way round)
- **Check:** the install has Google sign-in and password accounts; the password account's username is the same email as the Google account.
- **Cause:** they are two accounts. Hatchabot never joins a Google sign-in and a password account by their address: each has its own agents, AI sources, settings and memberships.
- **Fix:** nothing is wrong. Sign in the way that owns what you want to see. To give the other account an agent, share it with that account (Sharing → Members → **Share with someone on this Hatchabot…**, where each person is marked Google or password), or send that account a copy with **📨 Send to someone here**.
- **Fixed in:** —
- **Code:** `src/store/store.ts` — `identityOwnerForEmail`, `listSignInAccounts`

### Settings says "invitation not accepted yet" for someone who has used Hatchabot for months, and "Send a reset link" is gone
- **Check:** in Settings, under "Accounts on this machine", the row has the chip and **Copy invitation**, with no agent count. They or the owner asked for a reset link recently, and it was not used. The link copied may say it has expired.
- **Cause:** the roster called any code on the row an invitation, and an expired code stays on the row. A reset link is a code too, as is an invitation never claimed past its 48 hours.
- **Fix:** upgrade. Their password was never affected. A member with a password keeps the agent count and **Send a reset link**, and an expired invitation says so, with **Send a new invitation**. Without upgrading: `hatchabot accounts reset-password <username>` on the machine.
- **Fixed in:** `v2.173.0`
- **Code:** `src/api/accountsAuth.ts` — `'/v1/local-accounts'`, `'/v1/local-accounts/:id/reset-link'`; `web/index.html` — `loadAccounts`, `sendResetLink`, `copyAccountInvite`

### Turning on family accounts answers "An account already exists — restart to finish switching", and restarting changes nothing
- **Check:** the app still asks for the shared password after a restart, and `.env` has no `HATCHABOT_AUTH=accounts`. The service stopped, or the machine lost power, during the switch. The recovery code was never shown.
- **Cause:** the switch makes the account first and writes `.env` second. A crash between the two left an account that nothing finished, and every try was refused because an account existed.
- **Fix:** upgrade, then press **Turn on family accounts** again: an account nobody has used is replaced, the switch finishes, and a new recovery code is shown. An account that has been used, or was made with `hatchabot accounts create`, is kept and the answer says how to use it: set `HATCHABOT_AUTH=accounts` in `.env` and restart. The same hand fix works without upgrading; make a recovery code afterwards in Settings.
- **Fixed in:** `v2.173.0`
- **Code:** `src/api/routes.ts` — `'/v1/auth/family-accounts'`, `halfMadeFamilyAccount`; `src/store/store.ts` — `localAccountNeverUsed`

### After turning on accounts, "Only bots I parked" is off again, problem report drafts are gone, or budget and spending alerts stopped
- **Check:** the install went from the shared password to accounts. The owner's agents moved to the new account, but Settings → Messaging shows **Only bots I parked** off though it was on, Report a problem lists none of the earlier drafts, and an agent's budget or "Tell me every $X" alert no longer sends its message.
- **Cause:** the first account takes over what the shared-password owner had, from a list of tables kept by hand. The newer ones were missing from it: preferences, problem reports, budgets, spending alerts, usage warnings and a few more stayed with the old owner.
- **Fix:** upgrade before turning on accounts: every column that names the owner is moved, and a test checks the list against the database. On an install already switched, set the preference again and set each budget or alert again (that saves it under your account); old drafts can be written again.
- **Fixed in:** `v2.178.0`
- **Code:** `src/store/store.ts` — `adoptLocalOwnerData`, `OWNER_COLUMNS`

### After turning on accounts, the owner's first sign-in shows no agents until the service restarts
- **Check:** the service log has "could not hand this installation's data to the first signed-in account" (from v2.178.0), or, on an older release, the agents came back only after a restart.
- **Cause:** handing the old owner's agents to the first account failed once (a busy or damaged database), and the process never tried again: it had marked the hand-over done before trying.
- **Fix:** upgrade: a failed hand-over is tried again on a later request from the same account, after 30 seconds, then 1 minute, 2 minutes and so on, up to an hour between tries. The first failure is logged as an error, the rest as warnings. If it keeps failing, check the disk has room (`df -h`), read the error in the log, then restart the service (`./scripts/restart.sh`). On an older release, restart the service.
  - Only the account that tried first gets it, even after a restart, so a member who signs in meanwhile does not. In accounts mode only the machine's owner (account #1) can be that account, and what a member made before the owner signed in (an AI source, an agent) does not stop it. Nothing is held on an install that handed its data over long ago. It runs while the old owner has anything it moves, not only an agent, source or machine: with its agents deleted, its Google connections, spare pool bots, peers, command-line tokens and settings still go to that account.
  - Once everything is handed over, nothing more goes to anyone: an agent a leftover `dev-owner` command-line token makes later stays where it is. A "This machine" host made again at start goes to the install's owner: the host owner with accounts; with Google sign-in, the account the data was handed to, or on an install handed over before v2.178.0, the account that made the first source or agent (recorded then, once the old owner has nothing the hand-over moves, so it does not change).
  - What you make between tries does not block it: a class with the same name as one of yours comes over as "Name (2)", with its agents. A Google connection to the same account keeps yours (the newer consent), and the old one's agents move to it. They still hold the old sign-in, so its health view says to attach them again: Disconnect and attach each one. One the old connection was never delivered to stays "never delivered". A day's usage or security snapshot you already have stays yours.
  - An old agent with the same name as one of yours stays behind, with its budget, members and the rest. An AI source, machine or Google connection that only such agents use stays with them; one that any agent of yours uses is yours. The log says "some of this installation's agents stayed with the old owner". Rename or delete yours, then restart the service.
  - The log says "this installation's data is held for the account that signed in first" when another account (not a member) signs in. That account takes it at its next sign-in. When the log says that account no longer exists, release the hold, then restart the service: `sqlite3 data/hatchabot.sqlite "DELETE FROM first_account"` (or the database `HATCHABOT_DB` names). A member's sign-in logs nothing.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/firstAccount.ts` — `firstAccountAdoption`, `RELEASE_PIN`; `src/store/store.ts` — `pinFirstAccount`, `adoptLocalOwnerData`, `localOwnerHasAnything`, `localOwnerHasData`, `mayTakeOverInstall`, `installOwner`; `src/index.ts`

### After Google could not be reached, Google sign-in says "Too many failed attempts", even with Google back
- **Check:** identity mode. Sign-in said "Could not reach Google to verify your login." a few times, then "Too many failed attempts — try again later." (HTTP 429). The machine's network or Google had a fault shortly before.
- **Cause:** every failed check counted as a wrong guess, even one where Google's keys could not be fetched. After 10 the address waited out the 15 minutes, or longer at the public address, where it also went on the security record as a burst of failures. It needs a fresh start or a rotated key, as keys already fetched keep working.
- **Fix:** upgrade: failing to reach Google answers 503 with the same message and is not counted. Without upgrading, wait out the window once the network is back.
- **Fixed in:** `v2.173.0`
- **Code:** `src/api/identity.ts` — `IdentityUnavailableError`, `#certFor`; `src/api/auth.ts` — `'/v1/session'`, `noteFailure`

### People on Discord or Slack were told the agent "no longer answers" there, but it still does
- **Check:** removing Discord or Slack from the agent answered "Its runtime could not be confirmed stopped", "busy" or "changed meanwhile", and the bot is still listed on the agent.
- **Cause:** the goodbye DMs went out before the removal took the agent's lock and stopped it, so a removal that was then refused had already told everyone.
- **Fix:** upgrade: the goodbye goes out only once the agent holds still and is stopped, just before its bot is parked. Tell those people it is still there, or remove it again.
- **Fixed in:** `v2.169.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/channels/:kind'`, `dmChannelPeople`

### A new agent on a pool bot answers messages that were sent to the bot's previous agent
- **Check:** the agent was just created (or brought back) on a bot from the pool that served another agent within the last day; its first replies answer messages sent before it existed. The service log has no `pool.updates_dropped` line for that bot at the lease, or has `pool.updates_not_dropped`.
- **Cause:** Telegram keeps a bot's unconfirmed updates for up to 24 hours. A pool bot released by one agent and leased to another still held what people had sent the first, and the new agent's gateway read them as its own.
- **Fix:** upgrade. A lease now confirms every waiting update before the new agent starts. `pool.updates_not_dropped` with "Conflict" means the previous agent's gateway was still polling the bot: stop it, then Change bot on the new agent.
- **Fixed in:** `v2.169.0`
- **Code:** `src/channels/telegramPool.ts` — `provision`, `#dropWaitingUpdates`

### Some members never got the "archived" or "removed" goodbye from an agent's bot
- **Check:** the agent has many members; the service log's `pool.farewell` line for it shows `failed` above 0.
- **Cause:** the goodbyes were sent in a plain loop that ignored Telegram's "Too Many Requests" answer, so on a large membership the ones past the rate limit were dropped.
- **Fix:** upgrade. A goodbye refused for the rate limit is sent again after the wait Telegram asks for, up to 30 seconds in all; those it still cannot reach are counted in `pool.farewell`. Tell them the new link yourself.
- **Fixed in:** `v2.169.0`
- **Code:** `src/channels/telegramPool.ts` — `#farewell`, `FAREWELL_WAIT_MS`

### After Detach Telegram, two agents answer on one bot (the detached agent's tile said Stopped)
- **Check:** the agent the bot was taken from showed Stopped, but `docker ps` lists its container as running; the bot then went to another agent from the pool, and each one's log shows it polling Telegram.
- **Cause:** Detach stopped the container only when the record said RUNNING. A record that had drifted to STOPPED while the container ran was trusted, and the bot went back to the pool with its old agent still polling it.
- **Fix:** stop the old container (Stop on its tile, or `docker stop` it). Since the fix Detach stops the container whatever the record says and confirms it stopped before the bot goes back; when it cannot, the bot stays and Detach says "It did not stop".
- **Fixed in:** `v2.171.0`
- **Code:** `src/api/routes.ts` — the `'/v1/agents/:id/telegram'` delete route, `stopAndConfirm`; `src/orchestrator/quiesce.ts` — `stopAndConfirm`

### The Bot pool lists a bot in use by an agent that was deleted while its Telegram was being added
- **Check:** Settings → Messaging → Telegram → Bot pool shows a bot leased to an agent that no longer exists; that agent was deleted while Add Telegram was still finding it a bot.
- **Cause:** the attach checked the agent before it went looking for a bot and not after, so it saved the bot (row and token) on the deleted agent.
- **Fix:** upgrade; remove the bot from the pool and park it again to free it. Since the fix an attach that finds its agent gone (or no longer running or stopped) connects nothing and sends the bot back, and says so.
- **Fixed in:** `v2.171.0`
- **Code:** `src/api/routes.ts` — the `'/v1/agents/:id/telegram'` post route, `attached`

### "Who can reach it" says Invite only, and strangers can still knock
- **Check:** reopen the agent's Telegram tab: on an older release a save that failed left the select on your choice, and the tab drawn afresh shows the saved one. A brief error toast came at the time.
- **Cause:** the failure was only said in a toast, and the select kept the value that was not saved. Rich messages did the same.
- **Fix:** set it again once the service answers. Upgrade: a failed save puts the select back on the saved value.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `chanAllowKnocks`, `chanRichMessages`, `chanSelectBack`

### A parked Discord or Slack bot left the pool for an agent that was being deleted
- **Check:** you connected a Discord or Slack bot to an agent and deleted the agent before the connect answered. The bot is no longer parked under ⚙ Settings → Discord (or Slack), and no agent has it.
- **Cause:** the connect asked whether the agent could take an app only before the platform checked the token. Deleted meanwhile, the deleted agent got the channel and its stored token, and a parked bot taken for it left the pool.
- **Fix:** park the bot again with its token under ⚙ Settings → Discord or Slack. Since the fix, the connect asks again once it holds the agent and answers "It was deleted.", and a parked bot stays parked.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/channels/:kind'` (POST), `agentGone`

### The Telegram card shows the old bot's name or group warnings after Re-check and Change bot
- **Check:** the agent's Telegram card shows the old bot's name, or group warnings that are not true of the new bot, and you pressed Re-check just before changing the bot.
- **Cause:** a re-check that was waiting for Telegram's answer about the old bot wrote it over the new bot's details.
- **Fix:** press Re-check again. Since the fix, a re-check whose bot was changed meanwhile writes nothing and says "Its Telegram bot changed meanwhile — look again."
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/channels/:kind/recheck'`

### Security → Agent exposure says "low" or "medium" for an agent shared on Discord, Slack or web chat
- **Check:** ⚙ Settings → Security → Agent exposure names the people on Discord or Slack under "can message it", yet gives no "N people can message it" reason, and an agent that writes a shared folder reads "medium"; people given web chat are marked "invited, not yet linked".
- **Cause:** the count of who can reach an agent read Telegram only. Discord and Slack members and web chat guests were left out of it, so a powerful agent shared outside Telegram never reached "high".
- **Fix:** upgrade. The count takes everyone let in on any chat app or given web chat, and the list marks only people who have none of these as not linked yet.
- **Fixed in:** `v2.178.0`
- **Code:** `src/orchestrator/posture.ts` — `computePosture`

### `hatchabot adopt --reuse-bot` gave the agent a pool bot, and the old bot was not taken over
- **Check:** adopt printed "already has a bot: @…" (or the web app's adopt took over its bot), but the new agent's Telegram tab names another bot, and Settings → Messaging has one spare fewer.
- **Cause:** adopt did not ask to skip the pool. With a spare bot there, the agent came up on it, and the step that hands over the old bot never ran.
- **Fix:** upgrade: `--reuse-bot` skips the pool, hands over the old bot before the workspace is copied, and stops (removing the new agent) if the agent does not wait for that bot. After the hand-over it waits for setup to finish, however long it takes, and counts the bot as refused only when setup asks for a bot again. If the agent fails to start, before the hand-over or after it, adopt says it "could not start" and why, removes it and copies nothing. The web app's adopt with "Take over its bot" does the same, and waits as long as the CLI (15 minutes) for setup; an agent not yet running then (setting up, rebuilding or stopped) is left to finish once its bot was handed over, by the web app and the CLI alike, and they say so (the CLI names `hatchabot setup-log <id>` to watch), rather than removing it. One still setting up before anything was handed over (its old bot, or a pasted token) is removed, as the CLI removes it, and it says so (or that the delete was refused, and why). For an agent already adopted on a pool bot: delete it (its pool bot goes back to the pool), then adopt again with `--reuse-bot`.
- **Fixed in:** `v2.178.0`
- **Code:** `src/cli.ts` — `'adopt'` (`skipPool`), `pollAgent`; `src/api/routes.ts` — `'/v1/agents/:id/channel-token'`; `web/index.html` — `doAdopt`, `pollAgent`

### `hatchabot create` with a pasted bot token says "is RUNNING" while the agent is still being set up, or `hatchabot adopt` removes the agent it just made
- **Check:** `hatchabot list` shows the agent PROVISIONING right after create said it was running; or adopt with a pasted token (`HATCHABOT_BOT_TOKEN` or the prompt) failed and removed the agent; or adopt stopped on "Telegram did not answer" and removed the agent.
- **Cause:** the server took the token and answered while the agent still showed the "waiting for a bot token" step. The CLI's first look after that took the old step as the end: create printed RUNNING, and adopt went on to copy the workspace into an agent still being set up. A first fix waited 30 seconds for setup to take the token up, so a slower setup (a busy machine, a slow Telegram) still read as a refused token. And "Telegram did not answer" (503) was taken as a wrong token.
- **Fix:** upgrade: the server marks the step answered when the token comes in, and shows the agent as setting up; setup clears the step when it takes the token, and asks again only if it turns the token down. The CLI waits for the agent to run, fail or ask again, however long setup takes. The CLI tells such a server by what its `/v1/config` says (`handover: 2`), not by timing: there, and in the web app's adopt and paste-a-token box (which talk to their own server), a 409 to a post sent again makes it read the agent, and a step still open means the first post never landed, so that 409 is the refusal and the agent is removed; a step answered is watched on. Against a server of v2.177 or before, which shows the step until setup takes the token and does not tell a refusal apart, a step that stays 30 seconds after the hand-over stops the CLI with the agent left to finish (watch `hatchabot setup-log <id>`), not removed; so does a post sent again after no answer that such a server answers 409 (it took the first). When the agent runs on another bot than the one handed over (by the server's name for it, not the workspace's account key), create and adopt say which, and that the pasted bot was not used. "Telegram did not answer" (502, 503 or 504), or a connection refused, reset or dropped before an answer (another error, such as an invalid address, is not), is sent again on its own, with the same token, after 2, 4 and 8 seconds, by the CLI, by the web app's adopt and by its paste-a-token box; the CLI asks for the token again only when the token itself is refused (400 or 422, which includes a spare pool bot's token); a 409 about the agent (it is not waiting for a token, or another token came in already) stops with that message. A post the server took already (a proxy's 504 lost its answer) is answered 202 again when it brings the same token; another token gets 409. "Go on without a bot" sent again is answered 202 again only where the step was answered so; an agent made web-only, that never waited, gets 409. create says RUNNING only once it is, and otherwise says what state the agent is in. adopt copies the workspace only into a running agent: when setup turns the token down, it says the agent "is PROVISIONING and waiting on you", removes it and copies nothing. Check the token with @BotFather and run adopt again. On an older release, wait for `hatchabot list` to show RUNNING before using the agent.
- **Fixed in:** `v2.178.0`
- **Code:** `src/cli.ts` — `'create'`, `'adopt'`, `pollAgent`, `HANDOVER_SAYS`, `HANDOVER_RETRY_MS`, `STEP_GRACE_MS`, `tokenTurnedDown`, `noAnswer`, `otherBotLine`; `src/api/routes.ts` — `'/v1/agents/:id/channel-token'`, `sameTokenAgain`, `'/v1/config'`; `src/store/store.ts` — `telegramSkippedByOwner`; `web/index.html` — `handOverBot`, `submitToken`

### An agent shows "Setup was interrupted — tap Retry" right after its bot token was pasted
- **Check:** the token was pasted (in the app, `hatchabot create` or `hatchabot adopt`) and accepted, and the agent's Setup log then has `reconcile.interrupted`, with no `channel.provisioned` after its last `channel.setup_required`. Either a setup or rebuild of that agent was still running when the token came in (a Retry, or setup still ending after it asked for the token), or Hatchabot restarted between the paste and setup.
- **Cause:** the server cleared the "waiting for a bot token" step when the token came in, outside setup. With a setup still running, the new setup was not started; after a restart, the token was gone, as it was held only in memory. Either way the agent was left setting up, with no step and nothing running, and the health sweep failed it.
- **Fix:** upgrade: the token is held on disk with the agent until setup takes it, and the step stays, marked answered, until then. A token that comes in while a setup or rebuild runs is taken by a setup right after it; so is "go on without one", which then ends web-only. Two answers at once: the first is taken and the other is refused. When another change holds the agent (an import, a move), setup waits for it, up to 30 minutes, rather than failing. After a restart, setup runs again with the held token; an answer whose token never got stored asks again, and the restart's note in Activity says which happened (or that setup goes on without a bot). Deleting the agent, or going on without a bot, drops a held token; a delete that is refused leaves it to setup, and a token posted while the agent is being deleted is told "It is being deleted." Held tokens are kept in memory and read from the store once, at start, all at once; one let go or taken while that read runs is not brought back by it. Adding a bot whose token cannot be stored, or whose setup then fails, lets the pasted token go, from memory and disk, before it answers. A held token also goes once the agent gets a bot another way (attached from the pool, or setup ends with another bot), so it never wins over the pool later. Adding a bot to an agent checks a pasted token (with Telegram, against other agents' bots and the pool's spares) before it is held, so a refused one is never stored. A step asked again after it was answered shows in Alerts again, even if it was cleared before; one put back because the token could not be stored is not asked again, so a Clear stands. On an older release, tap Retry and paste the token again.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `provisionWhenFree`, `sameTokenAgain`, `'/v1/agents/:id/channel-token'`, `'/v1/agents/:id/telegram'`, `resumeOperations`; `src/channels/telegramManual.ts` — `pendingRef`, `loadHeld`, `waitingFor`, `heldBot`, `sameToken`; `src/orchestrator/provision.ts` — `runProvisionSteps`; `src/orchestrator/operationsResume.ts` — `resumeBackground`, `tokenKept`; `src/store/store.ts` — `setAgentPendingAction`

### Adding a bot, pasting a bot token or importing an agent with a bot waits for minutes, or never answers
- **Check:** Telegram, or a proxy in the way, was slow or down at the time (`curl -m 10 https://api.telegram.org` from the machine).
- **Cause:** the token is checked with Telegram, and that check had no deadline: a Telegram that did not answer, or answered slowly, held the request.
- **Fix:** upgrade: the check gives up after 10 seconds with "Telegram did not answer, so the token could not be checked. Try again in a moment." The token may be fine: try again once Telegram answers.
- **Fixed in:** `v2.178.0`
- **Code:** `src/channels/telegramManual.ts` — `verifyBotToken`, `TelegramUnavailableError`

### "That token didn't work" or "Too many token checks" while Telegram was down, for a token that is fine
- **Check:** the same token works a few minutes later, or `curl -m 10 https://api.telegram.org` from the machine failed or showed a proxy's error page at the time.
- **Cause:** any answer to the token check that was not a good bot counted as a wrong token: a proxy's 502 page, Telegram's own 5xx or its 429 (too many requests). Adding a bot to the pool also counted a check Telegram never answered as a failed try, so a few tries during an outage locked the person out of token checks for a while. Importing an agent said "Telegram rejected the bot token".
- **Fix:** upgrade: only Telegram's own "no" (401 or 404) means a wrong token. Anything else answers 503 with "Telegram did not answer, so the token could not be checked. Try again in a moment.", does not count against the person, and an import says to try it again. On an older release, wait until Telegram answers, and wait out "Too many token checks" if it shows.
- **Fixed in:** `v2.178.0`
- **Code:** `src/channels/telegramManual.ts` — `verifyBotToken`; `src/api/errorHandler.ts` — `installErrorHandler`; `src/api/routes.ts` — `/v1/pool`; `src/orchestrator/transfer.ts` — `importAgent`

## Agents, builds and rebuilds

### An agent I had stopped, or one asleep, came back up after I moved it to another source or changed a setting
- **Check:** its Setup log shows `rebuild` steps right after the change, and the agent was stopped or asleep (💤) before it. The changes that did this: Bulk actions → Move to source, Settings → AI → Switch & rebuild, Migrate all (other accounts' agents too), its browser, connecting or removing a chat app, swapping a bot, and where a Discord or Slack bot answers.
- **Cause:** those paths rebuilt a stopped agent to apply the change, and a rebuild ends with the agent running: answering on its chat apps and able to spend on its source. Nothing warned about it.
- **Fix:** upgrade, and press Stop if it came up. A stopped or sleeping agent now stays down through such a change: its card says "A change is waiting", and its next Start or wake is a rebuild with the change in it, whatever the Automatic rebuilds policy says. A Rebuild pressed by name still starts it, and says so first. One exception: a sleeping agent given a Discord or Slack bot comes up, since nothing wakes it for those. While a move, an import, a restore or an archive is under way or waiting for your choice, these changes are refused with that operation's line: it stopped the agent, not you, and it decides what runs next. Settle it, then make the change.
- **Fixed in:** `v2.173.0`
- **Code:** `src/api/routes.ts` — `rebuildOrOwe`, `oweRebuild`, `operationRefuses`, `switchAgentToSource`, `startStopped`; `src/orchestrator/hibernate.ts` — `wakeAgent`, `rebuildOnWake`

### A move to another Hatchabot is refused: `An agent with id "…" already lives here`, and you have no such agent there
- **Check:** on that server, another account has an agent with the same id (`hatchabot list --all`, as the host owner). Download a copy and restoring it there, under your account, works.
- **Cause:** the check before a move looked for that id across every account, while the import it protects only refuses one under the same account. Nothing would have collided: container names carry the agent's own unique id.
- **Fix:** upgrade the server you are moving to. On an older version, use Download a copy and restore it there.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/migrate.ts` — `preflight`; `src/orchestrator/transfer.ts` — `importAgent`

### After a failed setup, the bot told everyone "This agent has been removed", but it is only FAILED
- **Check:** the agent still exists, FAILED with a Retry button; the message arrived around the time its first boot or restore failed.
- **Cause:** undoing a failed setup gave the bot back to the pool with the same call Delete uses, and that call says goodbye.
- **Fix:** upgrade: a failed setup now says nothing to members. On an older version, tell them the notice was wrong and press Retry; the notice cannot be taken back.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/provision.ts` — `runProvisionSteps`; `src/channels/telegramPool.ts` — `#farewell`, `setup-failed`

### An agent waiting for a bot token turns FAILED with "The agent runtime is missing", again and again, and the pasted token is gone
- **Check:** the agent's first boot failed once; its trail shows `reconcile.runtime_missing` within a couple of minutes of each Retry, while it showed the token prompt.
- **Cause:** undoing the failed setup removed the container but left its name on the record, and deleted the pasted token. Retry then parked it on the token prompt, and the next health sweep read the missing container as damage. Every other rule of that sweep leaves an agent waiting on its owner alone.
- **Fix:** upgrade: it stays waiting, and a pasted token is kept for the Retry (until a restart: it waits in memory, as a freshly pasted one does). On an older version, press Retry and paste the token before the next sweep, or skip Telegram.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/reconcile.ts` — `applyReconcileRule`; `src/channels/telegramManual.ts` — `setup-failed`

### After a failed restore, clone or import, Retry stops on a BotFather token prompt
- **Check:** it was restored, cloned, derived or imported; its first attempt failed; the pool has no free bot now. The Restore dialog says it comes back without Telegram when no bot is free.
- **Cause:** that promise was passed to the first attempt only, so a Retry asked for a token like a brand-new agent.
- **Fix:** upgrade: the choice is kept on the agent until it runs, and a Retry goes on web-only. On an older version, press **Continue without Telegram** on the prompt.
- **Fixed in:** `v2.173.0`
- **Code:** `src/api/routes.ts` — `kickProvision`, `setAgentWebOnlyIfNoBot`

### A refused move said "Your agent is unchanged", and then Delete said its bot is "NOT parked" because of a copy
- **Check:** the agent was stopped or asleep when the move started, and nothing has started it since; the Delete dialog says "A copy of it was downloaded", though you downloaded nothing.
- **Cause:** a move makes its copy with the same step Download uses, which marks the agent as having a copy elsewhere. Undoing the move left the mark, so Archive and Delete treated the bot as the copy's: a pool bot left the pool, and a pasted bot's token was dropped.
- **Fix:** upgrade: an undone move puts the mark back as it was. On an older version, press Start once before Archive or Delete, which clears it. If the bot is already gone, add it again with its BotFather token.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/migrate.ts` — `undoSource`, `exportedBefore`; `src/orchestrator/archive.ts` — `copyElsewhere`

### A failed move said "Your agent is unchanged" or "rolled back", but the agent is STOPPED
- **Check:** the agent's trail has `migrate.restart_failed` or `move.source_restart_failed`; it was running before the move.
- **Cause:** a move stops the agent first. When the move failed and starting it again failed too, that second failure was dropped and the message was the one for a clean undo, with no alert.
- **Fix:** press Start, or Rebuild if the old container is the fault (a pruned image, a taken port). Since the fix both kinds of move say it did not start again and their operation shows as failed. The agent's tile reads "Stopped: it did not start again", the reason is on its page and in Alerts until it next runs, and the owner of a move a restart undid is told on their chat app. The agent stays on the machine it was on, stopped, and Start, Rebuild, Move, Archive and Delete all work: nothing waits for a choice. On an older version a restart's undo that could not start it was held on the agent's page with Try again, refusing all of those until it started; upgrading makes Try again end it either way.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/migrate.ts` — `undoSource`, `migrateSteps`; `src/orchestrator/moveHost.ts` — `putBack`, `NOT_STARTED`, `endPutBack`, `tellNotStarted`; `src/store/store.ts` — `markNotStarted`; `web/index.html` — `agentAttention`, `v2Status`

### Move refused: "A rebuild of this agent is not over yet"
- **Check:** its tile reads "Waiting its turn to rebuild", or another rebuild in the fleet is holding the queue.
- **Cause:** a rebuild carries a change that only a new container picks up. Before the fix a move could begin under it, which called the rebuild off, and if the move was then undone the agent ran on without that change, with nothing saying one was still owed.
- **Fix:** wait for the rebuild, then move it.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/moveHost.ts` — `moveInner`, `rebuildWaiting`; `src/api/routes.ts` — `kickRebuild`, `stoppedWhileQueued`

### Archive answered "Another operation is already running", and the agent ended up running on another machine
- **Check:** the agent's trail shows `agent.archiving` and then the move's steps within a few minutes of each other; **Save conversation to memory first** was ticked, and a move was pressed while that ran.
- **Cause:** an archive's memory turn runs before it takes the agent's lock, and only Rebuild knew to check for it. A move started in that window stopped the agent mid-turn, so the conversation was not saved and the archive was refused.
- **Fix:** upgrade: a move is refused while the turn runs. On an older version, archive the agent again where it now is; tick the same box, so it saves what the cut-off turn did not.
- **Fixed in:** `v2.173.0`
- **Code:** `src/api/routes.ts` — `busyNow`, `'/v1/agents/:id/move-host'`, `'/v1/agents/:id/rehost'`

### A stopped agent turned FAILED with "Something went wrong setting up your agent", from pressing Start or Rebuild
- **Check:** its container is still there and stopped (`docker ps -a`), and its Setup log has `rebuild.failed` with a reason such as a missing key. It had been switched to a source whose key is missing or no longer shared.
- **Cause:** the check that catches a refused rebuild before anything is touched ran only for a running agent. On a stopped one the refusal landed in the step that marks a rebuild failed, and a FAILED agent cannot be started. Start could do this too, when a required rebuild was due.
- **Fix:** upgrade. The agent now stays stopped with its container untouched, and the rebuild's operation fails with the reason ("Not rebuilt: … It stays stopped as it was."). Fix the source, then press Start. With nothing owed but a required rebuild, the next Start brings up the container as it is. On an older version, fix the source and press Retry.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/provision.ts` — `rebuildAgentInner`, `renderedEarly`; `src/api/routes.ts` — `startStopped`, `renderRefusedRecently`

### I pinned a stopped agent to an image, pressed Start, and it still runs the old image
- **Check:** the Pinned view names the new image, but `hatchabot list` or the agent's Runtime tab shows the old OpenClaw version; the note under Image said a stopped agent "moves when it starts".
- **Cause:** a plain Start boots the existing container, and a pinned agent was never counted as behind, so nothing rebuilt it.
- **Fix:** upgrade: Start or a wake now rebuilds an agent onto its pin when the container runs another image. On an older version, press Rebuild.
- **Fixed in:** `v2.173.0`
- **Code:** `src/api/routes.ts` — `pinNotRunYet`, `startStopped`

### A stopped agent came up running after Try on… → Pin & rebuild, or after ✕ (discard the trial) under Runtime images
- **Check:** the agent was stopped, asleep (💤) or paused by its budget before you pinned it or discarded its trial in Settings → Advanced → Runtime images, and its Setup log shows `rebuild` steps right after. The Hatchabot agent's try and end of a trial left such an agent stopped.
- **Cause:** the page rebuilt every agent it pinned or unpinned, and a rebuild ends with the agent running: answering on its chat apps and able to spend on its source. The question said "rebuild them now" for all of them.
- **Fix:** upgrade, and press Stop if it came up. Only running agents rebuild now. A stopped or sleeping one stays so, its card says "A change is waiting", and its next Start or wake moves it onto the image. The question and the result say which agents are which. On an older version, press Stop after the trial change if it came up.
- **Fixed in:** `v2.174.0`
- **Code:** `web/index.html` — `runTryOnAgents`, `discardTrial`; `src/api/routes.ts` — `oweRebuild`

### Asked to install a tool, an agent tries `sudo` or `apt-get`, or says it cannot install anything
- **Check:** the agent runs OpenClaw 2026.9 (its Runtime tab), and its `TOOLS.md` (the agent's files) holds "Installing tools (managed by Hatchabot)" while its `AGENTS.md` does not. Typing `/context` in its console lists the files put in every turn: on 2026.9 `TOOLS.md` is not among them.
- **Cause:** Hatchabot wrote the rules for installing tools (into HOME: `~/.local/bin`, `npm install -g`, `pip install --target ~/.openclaw/pylibs`, `on-rebuild.sh`) into `TOOLS.md`. OpenClaw 2026.9 no longer puts `TOOLS.md` in the prompt (its doctor merges the file into `AGENTS.md` instead), so the agent only knew them if it thought to open the file.
- **Fix:** upgrade, then rebuild the agent (or wait for its next rebuild). The section is now kept in `AGENTS.md`, which every OpenClaw version reads, once; Hatchabot's copy leaves `TOOLS.md`, and a `TOOLS.md` with nothing else in it is removed. Your own notes in either file stay, including ones the doctor already moved into `AGENTS.md`; OpenClaw's unedited `TOOLS.md` template, if the doctor moved that too, is taken out. On an older version, tell the agent in chat to read its `TOOLS.md` before installing anything.
- **Fixed in:** `v2.174.0`
- **Code:** `src/openclaw/workspace.ts` — `withInstallSection`, `toolsMdWithoutInstallSection`, `installConventionsSection`; `src/orchestrator/provision.ts` — `syncDataSourceDocs`, `syncInstallDocs`

### A rebuild stops with "A shared folder is no longer safe to mount", for a folder brought in from OpenClaw
- **Check:** the agent's Data lists a folder shared at its own path (brought in with "Bring in from OpenClaw"); the message names it, and says it is a symlink, is or holds a folder that may not be shared, or "would cover" a path such as `/usr`, `/opt` or `/home/node`.
- **Cause:** every shared folder is checked again at each build, and a folder shared at its own path lands at that same path inside the agent, which may not be on or over the agent's home or the image's system folders. Before v2.169.0 those folders were left out of the check.
- **Fix:** remove the folder from the agent's Data and share it again at `/data` (without "at its own path"), or share a folder that is safe; then rebuild.
- **Fixed in:** `v2.169.0`
- **Code:** `src/orchestrator/provision.ts` — `hostPathTargetProblem`, `sharePathProblem`, `buildRuntimeSpec`

### A rebuild or setup fails with `seed failed at "<step>": …`
- **Check:** the agent's Setup log (`rebuild.failed` / `provision.failed`) names the step, then the tail of stderr and stdout.
- **Cause:** one step of the workspace seed failed; the step named is the cause (older releases printed the last output of an earlier, optional step instead, such as "Plugin llama-cpp is not associated with a tracked package install").
- **Fix:** read the named step's output; Retry/Rebuild after fixing its cause. A first Discord attach on OpenClaw 2026.9 failed this way before v2.72.3: upgrade.
- **Fixed in:** `v2.72.3`
- **Code:** `src/providers/localDockerProvider.ts` — `SEED_STEP_MARK`, `seedFailure`

### An agent stays on "Deleting" and does not go away
- **Check:** its tile or page says it is being deleted long after Delete was pressed; Hatchabot restarted (or was stopped) while the delete ran. `hatchabot ls` shows it DELETING.
- **Cause:** a delete the process was stopped in leaves the agent DELETING, and nothing finishes it on its own. Before v2.171.0 the agent's page offered no Delete in that state, so only `hatchabot delete <agent>` finished it.
- **Fix:** open the agent and press Delete… at the foot of its Overview: it finishes the delete. While a delete is still running, a second one is turned away ("It is being deleted already").
- **Fixed in:** `v2.171.0`
- **Code:** `web/index.html` — `v2Pane`; `src/api/routes.ts` — `deletesRunning`, `deleteAgent`

### Trying a candidate image on agents did not save their conversation to memory first
- **Check:** after trying an image on agents (⚙ Settings → Runtime images → 🧪, Pin & rebuild), an agent's memory lacks what was said just before; its Setup log has no `memory.checkpointed` (or `memory.checkpoint_failed`) line for that rebuild.
- **Cause:** before v2.171.0 the trial's question said Chat → Memory runs first, but its rebuild did not ask for it.
- **Fix:** upgrade. Before trying an image with an older version, use 📝 Chat → Memory on the agent's Personality tab first.
- **Fixed in:** `v2.171.0`
- **Code:** `web/index.html` — `runTryOnAgents`; `src/api/routes.ts` — `/v1/agents/:id/rebuild`

### A new agent's first setup failed, and after Delete its volume is still on the disk
- **Check:** `docker volume ls` lists a `hatchabot-<name>-<id>-vol` for an agent that no longer exists; its setup had failed at the seed or at creating its container (a missing image, a Docker error) before it was deleted.
- **Cause:** the volume is made before the step that failed, but the agent was given no runtime until that step succeeded, so the rollback had nothing to remove and Delete found nothing to remove either.
- **Fix:** upgrade; a failed first setup removes the volume it made, or, when it cannot, keeps its name on the agent so Delete removes it. Remove an orphan left by an older version with `docker volume rm <name>` once you are sure no agent uses it.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/provision.ts` — `runProvisionSteps`; `src/providers/localDockerProvider.ts` — `runtimeRefFor`

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

### A rebuild says "Rebuilt", but the agent still runs as before (a new AI source or setting did not take)
- **Check:** the agent's Setup log has `rebuild.failed` with `keptRunning: true` at that time, and the rebuild's entry under its operations said "Rebuilt.".
- **Cause:** the new configuration could not be rendered (a missing credential, an un-shared source, an engine-free image with the memory service off), so the rebuild kept the old container running, and its operation was counted a success because the agent was still RUNNING.
- **Fix:** upgrade: the operation now fails with "Not rebuilt: … It keeps running as it was." Fix the cause it names, then rebuild.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/provision.ts` — `renderRefusalOf`, `rebuildAgent`; `src/api/routes.ts` — `kickRebuild`

### The agent's card says a model or source change landed, but the agent still answers with the old one
- **Check:** the source's default model (or the agent's source) was changed while the agent was rebuilding or being set up; `openclaw models status` in the container names the old model while the card names the new one.
- **Cause:** the build recorded as applied what the record said when the container was accepted, not what the container had been seeded with, so a change saved during a slow build was stamped as applied.
- **Fix:** upgrade, then rebuild the agent once: from v2.168.0 the record keeps the model the container was built with, and the change shows as still to apply.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/provision.ts` — `recordApplied`, `renderedFrom`, `buildRuntimeSpec`

### An agent you stopped started again by itself, rebuilt
- **Check:** its Setup log shows `rebuild.auto` a moment after your Stop, then a rebuild; the machine's rebuild policy is not `manual`.
- **Cause:** the automatic rebuild sweep chose the agent while it was running, then read its activity; a Stop in those seconds was not seen, and the rebuild (which starts the agent) went ahead.
- **Fix:** upgrade: the sweep checks the agent is still running, on the same machine, before it queues the rebuild. Stop it again meanwhile.
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/routes.ts` — `rebuildSweep`, `kickRebuild`

### The Setup log says the rebuild hook ran, but the tools it installs are missing
- **Check:** `rebuild_hook.ran` in the Setup log, and the hook's output shows an error; `docker exec <container> bash ~/.openclaw/on-rebuild.sh; echo $?` exits non-zero.
- **Cause:** the hook's output went through `tail`, whose zero exit status hid the hook's own, so a failed hook (or one stopped by the 5-minute timeout) was logged as having run, and one that failed silently was not logged at all.
- **Fix:** upgrade: a failed hook is logged as `rebuild_hook.failed` with its exit code. Fix the hook (`~/.openclaw/on-rebuild.sh`), then rebuild.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/provision.ts` — `runRebuildHook`

### After a restart during setup, a new agent runs but its repo data source never cloned
- **Check:** the agent was being set up when Hatchabot restarted; its setup operation says it was "marked running"; the repo source shows no last sync and no error, and parked scheduled tasks are missing.
- **Cause:** a setup cut off after the agent's gateway answered was marked running on health alone; the steps after it (git sources, connections, the rebuild hook, scheduled tasks) never ran.
- **Fix:** upgrade: such a setup's steps run again after the restart, as Retry runs them, keeping the volume. For an agent already affected, rebuild it.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/operationsResume.ts` — `resumeBackground`; `src/orchestrator/provision.ts` — `runProvisionSteps`

### An agent stays "Setting up" or "Rebuilding" for good after a restart
- **Check:** `docker inspect -f '{{.State.Status}}' <container>` says `dead` (or another state that is neither running, stopped nor restarting), and the agent's operation failed with "was interrupted by a restart".
- **Cause:** reconcile handled a runtime error only for a RUNNING agent; one cut off in setup or a rebuild was left in its busy state, and every sweep judged nothing.
- **Fix:** upgrade: it is marked FAILED "… was interrupted and its runtime reported an error — tap Retry". Then tap Retry (or `docker rm -f` the dead container first if Docker keeps it).
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/reconcile.ts` — `applyReconcileRule`

### An agent restarts on its own: "its OpenClaw process quit on its own — killed for memory (exit 137)"
- **Check:** the ↻ note on the agent and `runtime.self_restarted` in its Setup log; Resources shows cap hits for its container.
- **Cause:** the container reached its memory cap. An OpenClaw 2026.9 gateway idles near 1 GB and peaks well above.
- **Fix:** give the agent more memory (its sheet → Runtime → Memory cap, applied at once, or `hatchabot memory <agent> <cap>`), or the machine default (`HATCHABOT_AGENT_MEMORY`, 3g).
- **Fixed in:** —
- **Code:** `src/orchestrator/eventLabels.ts` — `runtime.self_restarted`; `src/config/envCatalog.ts` — `HATCHABOT_AGENT_MEMORY`

### An agent's tooltip says "Restarted by itself once … (last: a memory fault)" (before v2.178.1: "last exit 135: a memory fault")
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

### The Definition editor shows an empty SOUL.md (or AGENTS.md, MEMORY.md), and Save wiped the real one
- **Check:** the agent is on a runner that was asleep, or Docker was not answering, when the editor opened; the file came up empty with Save enabled (before v2.166.0). After a Save the agent's file is empty; the `pre-edit` snapshot (Snapshots on the agent's page) has what it held. The same read serves **Push definition**: a master whose files could not be read pushed nothing for that file in silence, and a SOUL.md the owner had emptied on purpose was left as it was on every child while the push said it succeeded.
- **Cause:** the read ran `head … || true` and used its output without looking at whether the command had worked, so a failed read and an empty file both came back as '' with status 200. The push built its layer from the same read and dropped a file that read as '', the only way it had to leave out a file it could not read.
- **Fix:** upgrade. The editor's read is the snapshot read now: a failed read is an error in words (502) and nothing loads, so there is nothing to save; a file that is not there is told apart from one that is there and empty (`missing: true`). The push refuses when the master's files cannot be read, and an emptied file is pushed as empty. On an older version, restore the `pre-edit` snapshot to get the file back, and open the editor only while the agent's machine is awake.
- **Fixed in:** `v2.166.0`
- **Code:** `src/api/routes.ts` — `/v1/agents/:id/files/:name`, `readCapped`; `src/orchestrator/snapshots.ts` — `readCoreFile`, `EMPTY_FILE_MARK`

### The Definition editor put back older text after you went to another file and back, and Save wrote it
- **Check:** on a slow machine (or with a large file) you picked SOUL.md, then another file, then SOUL.md again and started typing; the text changed under you to an older version, or emptied with an error.
- **Cause:** a read was matched to the editor by agent and file name only, so the first SOUL.md read, answering last, matched again and replaced the newer one.
- **Fix:** revert to the snapshot taken automatically before the save (its History list, under the editor), or put the text back by hand. Since v2.168.0 only the latest read fills the editor.
- **Fixed in:** `v2.168.0`
- **Code:** `web/index.html` — `loadEditFile`, `editLoadGen`

### A master's Proposals list shows another master's proposals, and Dismiss or Merge says it is not found
- **Check:** you opened one master's 📥 Proposals, then another's before the first list loaded; the list shows the first master's children's proposals under the second master's name.
- **Cause:** the first master's slow answer was drawn in the dialog of the master open since, and its buttons sent those proposals to the open master.
- **Fix:** close the master's Proposals and open it again. Since v2.168.0 an answer for a master no longer open is dropped.
- **Fixed in:** `v2.168.0`
- **Code:** `web/index.html` — `loadMasterProposals`, `resolveProposal`

### Push definition changed a child whose restore was interrupted ("is being put right")
- **Check:** after a restart, a child's page says its restore or move was interrupted and is being put right (Alerts), yet a Push definition from its master reported it pushed; the child's files are then a mix of the restore's and the master's, and its setup values changed under the recovery. Only before v2.166.0.
- **Cause:** the push checked that each child was RUNNING and not busy in memory; after a restart the in-memory busy flag is empty, while the operation on disk still protects the half-written files. Every other file-writing action also asks the operation on disk.
- **Fix:** upgrade. A child under an unfinished operation is now refused in the operation's words and named in the push's result while the others are pushed; a master under one is refused up front. Let the operation finish (or choose on its page under Alerts), then push again. For a child already written into, restore its `pre-params` snapshot once the operation is over.
- **Fixed in:** `v2.166.0`
- **Code:** `src/api/routes.ts` — `/v1/agents/:id/push-definition`, `busyNow`; `src/orchestrator/operations.ts` — `operationRefusal`


### After Push definition, a child has the master's old SOUL.md with its new AGENTS.md
- **Check:** the master's files were saved while the push was reading them (two tabs, or the Definition editor while a push ran).
- **Cause:** the push read the master's two files one after the other without holding the master, so a save between the reads went into the push half done.
- **Fix:** upgrade and push again. Since this release a save during the push's reads is refused as "Another operation is already running"; save again once it is done.
- **Fixed in:** `v2.171.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/push-definition'`

### Setup values: Apply says the write failed, and SOUL.md has the new values while AGENTS.md and the stored values have the old
- **Check:** the agent runs on a runner (or its machine's Docker stopped answering) at the moment of the Apply.
- **Cause:** a file whose write failed with an error was put back, but a write that broke off (the connection lost mid-call) skipped the putting back.
- **Fix:** upgrade, then Apply again, or restore the `pre-params` snapshot. Since this release both kinds of failure put back what was written, including a file that landed just before the connection was lost (in a Push definition to a child too); a file that cannot be put back is named, with the snapshot to restore.
- **Fixed in:** `v2.171.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/params'`, `'/v1/agents/:id/push-definition'`

### Setup values: an optional choice cannot be cleared ("must be one of: …")
- **Check:** the field is a choice that is not required, and the value sent is blank.
- **Cause:** a blank choice was checked against the list of options before anything else, so clearing it was refused; the form also had no blank to pick.
- **Fix:** upgrade: a blank clears an optional choice, and the forms offer "(none)" for it. A new agent's form still starts such a choice on its default (matched to its option whatever the case) or else its first option; "(none)" picked there leaves the value blank.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/template.ts` — `resolveParamValues`; `web/index.html` — `renderSetupValues`, `collectParamValues`, `choiceStart`, `submitParamForm`

### `hatchabot doctor`: "N running agents are still on the shared network"
- **Check:** the doctor line.
- **Cause:** those agents were made before agents got their own isolated network, which applies at a rebuild.
- **Fix:** `hatchabot rebuild --outdated`, or wait: unless the rebuild policy is manual, the machine rebuilds each once it is idle.
- **Fixed in:** —
- **Code:** `src/doctor.ts` — `sharedNetwork`

### `hatchabot rebuild --outdated` said "N rebuild(s) queued", but the agents were not rebuilt
- **Check:** the output has "not started: …" lines (an agent busy with another change, for example), and those agents still say they need a rebuild.
- **Cause:** a refused rebuild was printed but still counted as queued, and the command exited 0, so a script went on as if all were done.
- **Fix:** run it again once the agents are free. Since v2.168.0 it counts only the rebuilds the server took, says how many were not started, and exits 1 when any was refused.
- **Fixed in:** `v2.168.0`
- **Code:** `src/cli.ts` — `outdated`, `not started`

### `hatchabot rebuild <agent> --wait` says "is still RUNNING after N min", though the rebuild finished
- **Check:** `hatchabot ops <agent>` shows the rebuild as succeeded long before the command gave up, and the agent answers.
- **Cause:** `--wait` counted a rebuild as done only after it had seen the agent leave RUNNING; a quick rebuild that ended within its first two seconds was never seen leaving, so it waited out the timeout and exited 1.
- **Fix:** upgrade; `--wait` now follows the rebuild's operation to its end (step lines, then its outcome) and exits 1 only when the rebuild failed. On an older version, trust `hatchabot ops` over the timeout.
- **Fixed in:** `v2.171.0`
- **Code:** `src/cli.ts` — `followOperation`, `startedOperation`

### `hatchabot browser <agent> on` said "rebuilding now", but the agent got no browser
- **Check:** `hatchabot browser <agent>` says "on, not running yet" long after; the agent was already rebuilding (or busy with another change) when the command ran, was archived, failed or still being made, or it already had the setting asked for.
- **Cause:** the command printed "rebuilding now" whatever the server answered. The server rebuilds only a built agent that is running or stopped; otherwise it saves the switch for the agent's next build, and when a rebuild was already under way it said so, but the CLI dropped that message.
- **Fix:** upgrade; the CLI prints the server's message, or "saved. No rebuild was started", when no rebuild of its own was started, and "nothing to change" when the agent already had that setting. On an older version, rebuild the agent once the other rebuild ends (or once it is running again): `hatchabot rebuild <agent> --wait`.
- **Fixed in:** `v2.171.0`
- **Code:** `src/cli.ts` — `browserPending`; `src/api/routes.ts` — `browser.rebuild_pending`

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

### An archive of a stopped agent whose copy was downloaded ended "left as it was", and its bot is gone
- **Check:** the agent was stopped with a downloaded copy (Detach or Archive warned about it); its archive operation says "interrupted by a restart before its bot was given back"; the agent still lists a Telegram bot that the pool no longer has.
- **Cause:** Hatchabot restarted after the bot was left to the copy (a pool bot taken out of the pool) but before that was recorded, and the restart undid the archive as if nothing had been given up.
- **Fix:** upgrade: such an archive is finished after a restart. On an older version, archive the agent again.
- **Fixed in:** `v2.169.0`
- **Code:** `src/orchestrator/archive.ts` — `resumeArchive`, `leaveBotToCopy`

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

### An agent's "## Peers" section in AGENTS.md is cut short, or text from a peer's name reads as an instruction
- **Check:** one of the agent's peers has a name with a line break, a `#`, a run of backticks or `**` in it (an imported template's name can); in the agent's AGENTS.md, "## Peers" ends at a heading that came from that name, or the list's bold runs on.
- **Cause:** before v2.169.0 each peer's name went into the section as it was, as bold markdown, so a line break plus `## …` started a heading of its own in the agent's standing instructions.
- **Fix:** upgrade, then rebuild the agent (or change its peers): each name is written on one line in a code span. Renaming the peer to plain words also fixes it on older versions.
- **Fixed in:** `v2.169.0`
- **Code:** `src/openclaw/workspace.ts` — `peerToolsSection`, `peerOneLine`; `src/orchestrator/provision.ts` — `syncDataSourceDocs`

### An agent's browser opens no site: "strict browser SSRF policy requires an IP-literal URL"
- **Check:** in the agent, `openclaw config get browser` shows an `ssrfPolicy` block; `openclaw browser open https://…` answers "Navigation blocked: strict browser SSRF policy requires an IP-literal URL because browser DNS rebinding protections are unavailable for hostname-based navigation".
- **Cause:** `browser.ssrfPolicy` was set by hand (in the console, or with `openclaw config set`). With it written at all, even as `dangerouslyAllowPrivateNetwork: false`, OpenClaw 2026.9.8 refuses every address that is a name. Hatchabot never writes it: left unset, OpenClaw already refuses private addresses (the LAN, this machine, the browser's own control port).
- **Fix:** in the agent, `openclaw config unset browser.ssrfPolicy`, then restart the agent.
- **Fixed in:** not a Hatchabot bug; documented with `v2.180.0`
- **Code:** `src/openclaw/configWriter.ts` — `browser.evaluateEnabled` (the comment beside it)

### An agent says it cannot run a script in a page: "act:evaluate is disabled by config (browser.evaluateEnabled=false)"
- **Check:** the agent has its browser on and was rebuilt on `v2.180.0` or later; the gateway log or the agent's answer carries that line.
- **Cause:** on purpose since `v2.180.0`. OpenClaw's default let the model run any JavaScript in a page, including what the page itself told it to run. The agent still reads pages, clicks, types and fills in forms.
- **Fix:** none needed; ask the agent to do the step by clicking and typing. To allow scripts for one agent anyway: in it, `openclaw config set browser.evaluateEnabled true` and restart it; the next rebuild switches it off again.
- **Fixed in:** `v2.180.0` (the setting)
- **Code:** `src/openclaw/configWriter.ts` — `browser.evaluateEnabled`

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

### An older agent's browser never starts: "its browser did not start: agent container … is not running" while the agent runs
- **Check:** the name in that line is a bare id (no `hatchabot-` or `agentclaw-` in front), and `docker ps --format '{{.Names}}'` shows the agent's container as `agentclaw-` and that id's first 12 characters.
- **Cause:** the browser sweep took the ref's text as the container's name. Agents from before slug names have their container under the old naming rule, so the sweep looked for a container that does not exist.
- **Fix:** upgrade; the sweep and the browser's status ask the machine's provider for the container's name.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/browser.ts` — `containerOf`, `browserSweep`; `src/providers/localDockerProvider.ts` — `containerName`

### A changed `HATCHABOT_BROWSER_MEMORY` does not reach an agent's running browser
- **Check:** `docker inspect -f '{{.HostConfig.Memory}}' <agent container>-browser` still shows the old limit in bytes after the setting changed and Hatchabot restarted.
- **Cause:** the sweep kept a running browser while it shared the agent's network and image, without looking at its memory limit.
- **Fix:** upgrade; within a minute the sweep replaces a browser whose limit is not the one set (its in-memory profile starts again, as after an agent restart). On older versions, restart the agent.
- **Fixed in:** `v2.171.0`
- **Code:** `src/providers/localDockerProvider.ts` — `ensureBrowser`, `dockerMemoryBytes`

### `hbt import --no-telegram` brought the agent's bot back
- **Check:** the file was a full copy (a Download); the CLI said "restored".
- **Cause:** "no Telegram" applies only to templates and was silently ignored for full copies.
- **Fix:** a full copy always brings its bot. For a new agent with no bot, export a template and import that.
- **Fixed in:** `v2.153.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/import'`

### After importing a downloaded agent, your first message to its bot gets a pairing code
- **Check:** the agent came from a Download (a full copy) or a move; Members shows you as owner with no Telegram; a knock card (or `hatchabot pairing <agent>`) shows your request.
- **Cause:** an import drops the previous owner's Telegram from the owner's seat but started nothing to watch for yours, so your first message waited for approval by hand.
- **Fix:** upgrade: the owner's seat takes your Telegram when this machine already knows it, and otherwise your first message is claimed for half an hour after the import, as with a new agent (never the previous owner's). Until then, approve your own request from the knock card.
- **Fixed in:** `v2.169.0`
- **Code:** `src/orchestrator/transfer.ts` — `watchOwner`; `src/api/routes.ts` — `watchImportedOwner`

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


### A clone is missing some of its source's daily notes, and the message did not say so
- **Check:** in the source agent's Files, a folder under `memory/` (or a note) cannot be opened by the agent (its permissions were changed by hand or by a tool).
- **Cause:** the memory reader passed over a folder it could not open without listing it, and a note it could not read stopped the whole copy of the daily notes.
- **Fix:** upgrade: such a folder or note is named in the clone's message ("unreadable and stayed behind"). Fix its permissions in the source and copy the notes across, or clone again.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/template.ts` — `readCloneMemory`; `web/index.html` — `cloneAgent`

### A git data source added again still holds the old repo, or a writable one cannot push ("PUSH-DISABLED-read-only-public-clone")
- **Check:** in the agent, `git -C ~/.openclaw/<mount> remote -v` shows another repo than the source's card, or a push URL of `PUSH-DISABLED-read-only-public-clone` for a source added with a deploy key.
- **Cause:** removing a git source kept its clone on the volume (until v2.167.0, which deletes it). A source added again at the same mount found that clone and skipped cloning, keeping its old address and, from a public source, its disabled push URL.
- **Fix:** upgrade and rebuild the agent. A clone of the same repo is repointed (and can push again with a deploy key); a clone of another repo is moved aside to `<mount>.replaced-<time>` (its files are kept) and the new repo cloned.
- **Fixed in:** `v2.160.0` (#88, #89)
- **Code:** `src/orchestrator/gitSource.ts` — `retainedCloneCheck`, `buildGitSyncScript`, `buildPublicGitSyncScript`

### A git data source stops syncing with "Couldn't verify the git host's SSH key" (git host key)
- **Check:** the source's error says it is not the key this agent trusted; in the agent, `ssh-keygen -F <host> -f ~/.openclaw/.ssh/known_hosts` prints the key it trusts, and `ssh-keyscan <host>` prints a different one.
- **Cause:** the agent trusts a git host's SSH key from its first sync and keeps it. Before this release every sync added whatever key answered for the host, so a swapped key was trusted silently; now a different key is refused.
- **Fix:** compare the new key's fingerprint (`ssh-keyscan <host> | ssh-keygen -lf -`) with the one the git host publishes. Only if they match, run `ssh-keygen -R <host> -f ~/.openclaw/.ssh/known_hosts` in the agent and rebuild it; the next sync trusts the new key. If they do not match, do not clear it: something else is answering for that host.
- **Fixed in:** `v2.162.0` (#202)
- **Code:** `src/orchestrator/gitSource.ts` — `hostKeyTrustLine`, `gitSyncReason`

### Text at the end of an agent's AGENTS.md is gone after a rebuild, below a code example that quotes "## Data sources" (or another managed heading)
- **Check:** the agent's AGENTS.md has a code block that is never closed (a ```` ```bash ```` with no closing line), and later a ```` ```` ```` example that shows one of Hatchabot's headings (`## Data sources`, `## Peers`, `## Installing tools (managed by Hatchabot)`…). A snapshot (Files → Snapshots) or a backup from before may still have the text that went.
- **Cause:** code fences that do not balance are read two ways. Taken as closed, the quoted heading looked real, and Hatchabot rewrote "its" section from there to the next heading, which could be the end of the file.
- **Fix:** upgrade, then put the lost text back (from a snapshot or a backup) and close the code block. Now a heading the two readings disagree on leaves the file as it is, and a section ends at the first code fence after its heading too, so it never runs into the agent's code. Removing a section no longer changes blank lines anywhere else in the file. A ```` ``` ```` indented 4 spaces or more is read as text in an indented code block, not as a fence, as Markdown readers do. A template export (Share) still takes out every copy of Hatchabot's sections that either reading calls real, so the owner's details never travel because of the agent's fences.
- **Fixed in:** `v2.178.0`
- **Code:** `src/openclaw/workspace.ts` — `managedSection`, `fenceMask`, `FENCE_LINE`, `readFences`, `replaceSection`, `removeSection`, `removeSectionEverywhere`, `extractSection`, `withInstallSection`, `installBlocks`; `src/orchestrator/template.ts` — `stripManagedSections`

### An agent's AGENTS.md still lists a Google account, a peer or a folder that was taken away
- **Check:** the agent's activity says "AGENTS.md line N: some Markdown readers take it to close the code fence opened on line M and others do not, so … was left as it was", naming the section (once for each version of the file, not on every rebuild). Its AGENTS.md has a code block at line M that opens with one run of backticks and is closed at line N by a longer one, or never closed. Or it says "… left as it was, since a code fence above it does not close the way it opens", and a code block indented 4 spaces or a tab (in a numbered or bulleted list) quotes the section's heading at the start of a line.
- **Cause:** where the agent's code fences do not balance, Hatchabot cannot tell whether the section's heading is real or quoted in an example, so it leaves that section as it is rather than risk the agent's own text. Before the fix it did this without saying so.
- **Fix:** close the code block in AGENTS.md at the line it names (the same backticks it opened with, on a line of their own), or indent the quoted lines of an indented block as far as its fences, then rebuild the agent. The section is then brought up to date. A template export (Share) takes Hatchabot's sections out either way. Pushing a master's definition skips such a child, before any copy is taken, and reports "its AGENTS.md has a code fence that doesn't close above "Data sources"; fix it and push again" (or "Google accounts"): fix it the same way and push again. When it is the master's own AGENTS.md, a child with its own section of that name reports "<the master>'s AGENTS.md has a code fence that doesn't close above …; fix it there and push again"; one without gets the push with every copy of the master's Google accounts taken out.
- **Fixed in:** `v2.178.0`
- **Code:** `src/openclaw/workspace.ts` — `unsureSections`, `fenceDisagreement`, `readFences`, `fenceMask`, `readSection`, `managedSection`; `src/orchestrator/provision.ts` — `syncDataSourceDocs`; `src/api/routes.ts` — `push-definition`

### An agent's AGENTS.md changes on the rebuild after a section was added, with only a blank line removed
- **Check:** after a section was added to the agent's AGENTS.md (say `## Peers`, when it got its first peer), the next sync wrote the file again, and the only change was the blank line before that section taken out.
- **Cause:** a section was appended with a blank line before it, and the next sync replaced the section above it together with that blank line.
- **Fix:** none needed; it happens once. Since the fix a section keeps the blank lines that ended it, so a second sync writes nothing.
- **Fixed in:** `v2.178.0`
- **Code:** `src/openclaw/workspace.ts` — `replaceSection`

### An AGENTS.md edit saved just after adding a public repo is gone, and no snapshot has it
- **Check:** a public repo was added to the running agent shortly before the save; the saved text is not in AGENTS.md, which has the text from before the save plus a "## Data sources" section naming the new repo, and no snapshot holds the saved version (the save's own `pre-edit` snapshot has the text from before it).
- **Cause:** before v2.168.0 adding a public repo cloned it and then rewrote AGENTS.md's data-sources section in the background without holding the agent, unlike every other change to its files. The rewrite read AGENTS.md, and a save made before it wrote back was written over with the older text.
- **Fix:** upgrade: the clone and the rewrite hold the agent, so a save in those seconds is refused with "Another operation is already running on this agent"; save again once it is over. On an older version, write the edit again, and wait for a public repo's clone to finish before editing AGENTS.md.
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/data-sources'`; `src/orchestrator/provision.ts` — `syncDataSourceDocs`

### An AGENTS.md edit saved just after a memory cap, About you, Push definition or removing a repo is gone
- **Check:** shortly before the save, the agent's memory cap or the machine's agent memory default was changed, About you (the operator profile) was saved, its master pushed its definition, or a repo was removed from it; the saved text is not in AGENTS.md, which has the text from before the save with its "## Memory budget", "## About the operator" or "## Data sources" section updated.
- **Cause:** before v2.169.0 those changes rewrote AGENTS.md's managed sections in the background without holding the agent, as adding a public repo did before v2.168.0. The rewrite read AGENTS.md, and a save made before it wrote back was written over with the older text.
- **Fix:** upgrade: each rewrite holds the agent, so a save in those seconds is refused with "Another operation is already running on this agent"; save again once it is over. An agent busy with something else when the change is made gets its sections at its next start or rebuild. On an older version, write the edit again.
- **Fixed in:** `v2.169.0`
- **Code:** `src/api/routes.ts` — `syncDocsHeld`, `'/v1/operator-profile'`, `'/v1/machine-defaults'`, `'/v1/agents/:id/push-definition'`; `src/orchestrator/provision.ts` — `syncDataSourceDocs`

### An agent's template or downloaded copy will not import: "That template file is malformed or from an incompatible version" or "That export is malformed … (agent.dataSources)"
- **Check:** the agent has more than 32 data sources (Settings → Data lists them).
- **Cause:** a template and a full copy carry at most 32 data sources, but adding a source had no limit, so an agent could hold more and its own export could not be read back.
- **Fix:** upgrade, then remove data sources until it has 32 or fewer and export again. Since this release adding a 33rd source is refused ("already has 32 data sources").
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/dataSourceLimits.ts` — `MAX_DATA_SOURCES`; `src/orchestrator/template.ts` — `dataNeeds`; `src/orchestrator/transfer.ts` — `dataSources`; `src/api/routes.ts` — `'/v1/agents/:id/data-sources'`


### A template made here will not import ("That template file is malformed or from an incompatible version"), though the agent has 32 data sources or fewer
- **Check:** in Settings → Data, a folder or repo of the agent has a name over 128 characters; or Advanced → Extra credentials lists more than 64 variables.
- **Cause:** a template carries names of at most 128 characters and at most 64 variables. A folder or repo with a longer name was accepted, and two variables added at the same moment (two tabs) could each take the 64th place.
- **Fix:** upgrade, then remove the long-named source (rename the folder, or share it at its own path, and add it again) or the extra variables, and share again. Since this release a longer name is refused when added, and a variable past the 64th is refused even when two arrive together.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/dataSourceLimits.ts` — `MAX_MOUNT_NAME`; `src/api/routes.ts` — `'/v1/agents/:id/data-sources'`, `'/v1/agents/:id/env'`; `src/orchestrator/template.ts` — `parseTemplate`

### A downloaded copy of an agent will not import: "That export is malformed … (agent.model)" or "(agent.persona)"
- **Check:** for agent.model, the agent was held on its model when its AI source's default changed, and that model's name is over 64 characters; for agent.persona, the agent was made from a template whose setup answers fill its description past 8,000 characters.
- **Cause:** a hold pins the model the agent runs as its own, and a copy read an agent's model only up to 64 characters. A template's description could be filled past the 8,000 characters a copy reads.
- **Fix:** upgrade: the model is read up to 256 characters (and dropped, not refused, where the destination's source does not offer it). For the description, shorten the agent's description, and download it again; since this release setup answers that fill it past 8,000 characters are refused ("the description would be over 8,000 characters").
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/transfer.ts` — `importAgent`; `src/orchestrator/template.ts` — `renderPersona`, `MAX_PERSONA_CHARS`

### Two private repos with the same name are both data sources of one agent, and each sync swaps which one it holds
- **Check:** Settings → Data lists two git sources with the same name (the last part of their addresses), and the agent's `~/.openclaw/<name>` holds whichever synced last.
- **Cause:** both were added at almost the same moment (two tabs): the name check ran before each saved its deploy key, and neither saw the other.
- **Fix:** upgrade, remove one of the two sources, and rebuild the agent so its clone is the one kept. Since this release a name being added is held until its source is saved, and the second add is refused.
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/routes.ts` — `addingSources`, `'/v1/agents/:id/data-sources'`

### Sharing a folder "at its own path" says "… is already shared with this agent", but it is not
- **Check:** the agent already shares another folder at its host path whose path differs only in where the `/` and `-` fall (`/srv/recipes/family` and `/srv/recipes-family`).
- **Cause:** a host-path folder was told apart by a name flattened from its path, and the two paths flatten to the same name.
- **Fix:** upgrade: a host-path folder clashes only with the same folder, and its name gets a number when another has it.
- **Fixed in:** `v2.169.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/data-sources'`

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

### An app update says "Could not read the hatchabot.json of the release running now"
- **Check:** in the agent, `~/.openclaw/apps/<app>/releases/<sha>/hatchabot.json` of the running release is missing or not valid JSON, and the app's record names another release.
- **Cause:** the running release's tasks come off by its own manifest. Before `v2.168.0` a manifest that could not be read counted as "no tasks": an update that renamed or dropped a task left the old job running beside the new release, and said it had succeeded. Now the record's copy stands in when it is that release, and with neither nothing is changed.
- **Fix:** **Stop app** (it takes the tasks off by the record), then install the app again.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/apps.ts` — `installRelease`, `liveManifest`
### A move to another Hatchabot "could not be confirmed"; the agent stays stopped and Start is refused
- **Check:** `GET /v1/operations?agentId=<id>` shows `kind: "migrate"`, `status: "held"`.
- **Cause:** the import's answer was lost (a restart, a dropped connection, a proxy timeout) and the other server hasn't said whether the agent arrived; starting this copy could leave two copies polling one bot.
- **Fix:** wait (it asks again every 10 minutes), or check the other server and choose "It is running on … — keep this copy stopped" or "It is not on … — keep it here".
- **Fixed in:** `v2.154.0`
- **Code:** `src/orchestrator/migrate.ts` — `resumeMigrate`, `recoverMigrate`

### A move the other Hatchabot refused still says it "could not be confirmed", and asking again never settles it
- **Check:** the held `migrate` operation's peer is a Hatchabot of v2.154.0 or later, and on that server `/v1/moves/<move id>` answers `{"state":"failed"}` to its owner, while the service log there shows the 10-minute question as a `401` on `GET /v1/moves/…`.
- **Cause:** the source asks with the peer token that server gave it for moves, which opened only the import routes. The receipt route answered 401, which reads as "no answer", so a move the destination knew had failed stayed held. A second request under the same move id from another account could also write its outcome over the first one's receipt.
- **Fix:** upgrade the destination: the peer token may read its own move receipts (and nothing else), and a receipt is written only by requests of the account that made it. Until then, check the other server and choose "It is not on … — keep it here".
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/auth.ts` — `REHOST_MOVE_RECEIPT`, `cliBearer`; `src/orchestrator/migrate.ts` — `receiveMove`, `moveState`

### "Move to another Hatchabot" is refused: "This server's runtime image is OpenClaw X, older than the agent's Y", though the agent runs X
- **Check:** this machine's default image was upgraded and the agent has not been rebuilt since; its Runtime tab names the older OpenClaw version.
- **Cause:** the preflight sent this machine's default image's version, not the version the agent's own container runs.
- **Fix:** upgrade: the preflight sends the agent's own version, as the move's file does. Meanwhile, upgrade the other server's image.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/migrate.ts` — `migrateSteps`

### A move to another Hatchabot said "the agent DID arrive and is running there", but nothing there uses its bot
- **Check:** the other server has an agent with the same short name (slug) that answers on a different bot, and its own import of this agent failed afterwards.
- **Cause:** when the import's answer was lost (a proxy timeout), a RUNNING agent with the same slug there was taken as proof of arrival, even while the move's own receipt said its import was still under way.
- **Fix:** upgrade: while the receipt says the import is under way, the move waits for it (and is held, asked again every 10 minutes, if it does not settle). For an agent already affected: check the other server; if it is not there, choose "Runs here again" on this copy, then start it.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/migrate.ts` — `destinationHasAgent`, `moveState`

### After a restart, an agent you were importing is gone: "Import interrupted — import the file again"
- **Check:** the agent's operation is `kind: "import"`, `status: "rolled_back"`.
- **Cause:** the restart cut the import off before the agent was running; a half-imported agent is removed, never started.
- **Fix:** import the same file again.
- **Fixed in:** `v2.154.0`
- **Code:** `src/orchestrator/transfer.ts` — `resumeImport`, `rollbackImport`

### After an interrupted import, a container or volume of the agent is left behind, or its repo's deploy key is still stored
- **Check:** the import's operation is `rolled_back`, yet `docker ps -a` or `docker volume ls` lists a runtime of the agent's slug that no agent owns; or the secrets table still holds a `git/…` key no data source names.
- **Cause:** before `v2.168.0` the restart's undo knew only the runtime whose name had been saved and only the agent's environment secrets. A restart inside the first provision left its new runtime unnamed in the registry, and the repos' imported deploy keys were not collected before their rows were deleted.
- **Fix:** upgrade: the undo works out the runtime's name as the import does, and deletes the repos' keys with their rows. A runtime left by an older release can be removed with `docker rm -f` and `docker volume rm` once no agent uses it.
- **Fixed in:** `v2.168.0`
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

### Access lists Google accounts the agent never had as "removed — verified gone"
- **Check:** Sharing → Access on an agent with no Google account attached lists each of your Google connections, every one "removed — verified gone", after Verify now or a start, wake or rebuild.
- **Cause:** each look records every connection of yours as held or not, and the overview showed any not held as a removal for a week, whether or not the agent ever had it.
- **Fix:** upgrade. Only an account the agent had (found there before, or removed from it) shows as removed, for a week from when it went. Nothing was ever given to the agent: the rows were a display fault.
- **Fixed in:** `v2.170.0`
- **Code:** `src/orchestrator/googleConnections.ts` — `recordGoogleSeen`, `goneDetail`; `src/orchestrator/accessOverview.ts` — `accessOverview`

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

### The "a different token is running" warning went away after a Verify now, though nothing was rebuilt
- **Check:** the agent's chat-app line said ⚠ "a different token is running", then a later Verify now showed it ✓ with no rebuild or change of bot in between; the service log shows a failed read of a stored secret around then.
- **Cause:** when Hatchabot's own copy of the bot's token could not be read, nothing was compared, and the check was recorded as the right bot.
- **Fix:** upgrade; such a check keeps the difference found before (and its time) and lists the bot under what it skipped. Rebuild the agent to put the right bot back.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/accessOverview.ts` — `verifyAgentAccess`

### Access says a removed person is still let in, though only a turned-off bot account approved them
- **Check:** Verify now marks the person "removed, but the agent still lets them in"; their only approval is under a bot account that is switched off in the agent's settings (an old bot replaced by a new one), in OpenClaw's pairing store (2026.8 or newer).
- **Cause:** the approvals read from the pairing store were counted whatever account they were kept under, while those in an `allowFrom` file of a turned-off account were already left out.
- **Fix:** upgrade, then Verify now again: approvals under a turned-off account are not counted. Nothing could reach the agent through that account; the warning was wrong.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/accessOverview.ts` — `accessProbeScript`, `PAIRING_DB`

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

### A move is refused: "No matching AI source: … goes on the ⭐ Default source …, not …"
- **Check:** the destination has a ⭐ Default AI source of another vendor than the agent's, and also a source of the agent's vendor.
- **Cause:** an arriving agent goes on the destination's ⭐ Default source. Before `v2.168.0` the move's check named the matching source instead, so it approved a move that then ran (and billed) on the Default, a local agent included.
- **Fix:** the refusal offers that server's source of the agent's vendor: say yes to **Move onto …** (CLI: the `--profile <id>` it prints, `hatchabot rehost <agent> <server> --profile <id>`) and the agent lands on it. Or make the matching source the ⭐ Default there and move it again.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/transfer.ts` — `importProfile`; `src/orchestrator/migrate.ts` — `preflight`, `migrateAgent`, `sourceChoiceFrom`; `web/index.html` — `rehostAgent`
### Importing an agent's own download says "That export is malformed or from an incompatible version (ai.model)" or "(envVars)"
- **Check:** the agent's AI source names a model id longer than 64 characters (Settings → AI), or the agent has more than 64 environment variables (its Environment tab).
- **Cause:** the source machine accepted both, but the import read model ids up to 64 characters and at most 64 variables, so a valid agent's own copy was refused.
- **Fix:** upgrade the machine you import on; the same file then imports. The AI source's model is only a hint there, and an import takes up to 256 variables. From v2.160.0 an agent can have at most 64 variables set (an older one with more keeps them).
- **Fixed in:** `v2.160.0` (#162, #141)
- **Code:** `src/orchestrator/transfer.ts` — `ManifestSchema`; `src/orchestrator/envPolicy.ts` — `MAX_AGENT_ENV_VARS`, `MAX_IMPORTED_ENV_VARS`


### A downloaded copy of a large agent will not import: "That file isn't a Hatchabot export (or is too large)", though the download worked
- **Check:** the agent's saved state is close to the limit (about 201 MB compressed) and it has large environment values (its Environment tab: many, or values of several KB).
- **Cause:** the export set aside 8 KB for everything but the state, but an agent may have 64 environment values of 8 KB each. Near the limit, the file came out over the 256 MB an import reads back. Since v2.178.0 the export builds the rest of the file (environment values, bot token, settings) before it stops the agent and measures it, so a state that would not fit beside it is refused while the agent keeps running, and the state is held to the same measure after the copy.
- **Fix:** upgrade the machine you export from, then trim old sessions or move bulk data to a shared folder, and export again. A file made before cannot be imported. When the environment values alone come near the 268 MB a file can hold, the refusal says so, with their size ("settings and environment values alone come to about … MB"): remove the largest of them. Before the eleventh review it said "the limit is about 0 MB". With no room left at all (under 1 MB) it is refused at once, before the agent's volume is measured (twelfth review: it ran a trial compress of the whole volume only to refuse it).
- **Fixed in:** `v2.178.0`
- **Code:** `src/orchestrator/transfer.ts` — `stateAllowance`, `estimateStateBytes`, `exportAgent`, `tooLarge`, `NO_ROOM_BYTES`

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

### Security → Agent exposure says an agent can "send email as" an account that has only Calendar
- **Check:** the agent's Google account was connected without Gmail (Settings → Connections lists its services); the Security tab still lists "send email as …" under "can", and counts it as a powerful capability.
- **Cause:** the check looked only at the "block sending" switch, not at whether the connection holds Gmail.
- **Fix:** upgrade. Sending mail is listed only for a connection with Gmail and sending not blocked.
- **Fixed in:** `v2.178.0`
- **Code:** `src/orchestrator/posture.ts` — `computePosture`

### An agent says it cannot read Gmail, and you need to know why
- **Check:** the agent's Connections → **Test Gmail** beside the account, with the agent running. It checks the sign-in, then asks Gmail for the inbox's counts, and says which failed: the sign-in expired or was revoked, the OAuth client, an administrator's block, the Gmail API off in your Google Cloud project, Gmail unticked at consent, no mailbox, Google limiting or down, or no way out to Google.
- **Cause:** one of those; the test names it. Before it there was no way to tell them apart short of asking the agent. `gog` also keeps using an access token for up to an hour after the sign-in behind it was revoked, so a call that works does not prove the sign-in is good, which is why the test checks that first.
- **Fix:** the one the test gives. Most often: press Connect for the account under ⚙ Settings → Connections, then attach it to the agent again. A pass does not cover sending, which the test does not try.
- **Fixed in:** `v2.172.0`
- **Code:** `src/orchestrator/googleConnections.ts` — `testGmail`, `gmailFailure`; `web/index.html` — `testAgentGmail`

### An agent says it has no Google account, no Gmail or Drive tool and no shell, although one is attached
- **Check:** the agent's Connections → **Test Gmail** passes, or `gog auth list --json` inside the agent names the account, while the agent denies having it and may offer to set up OAuth or install a Google plugin. Hatchabot shows the account attached, and the agent's Setup log has `connection.materialized`. The agent's model is on OpenClaw's preferred list for Code Mode (`docs/tools/code-mode/configuration.md` in the OpenClaw package, for example `claude-sonnet-5`), and `tools.codeMode` is not set.
- **Cause:** OpenClaw's Code Mode, on by default for those models. The model sees an `exec` tool that takes JavaScript and is told it is not a shell, and searching its tool catalog for `gog` or `gmail` finds nothing, because `gog` is a shell command. Before this fix nothing told the agent an account was attached, and its `openclaw` tool reported none, because accounts are not in OpenClaw's config. The agent may then have saved "no Google account" to its `MEMORY.md`. The sign-in itself is fine.
- **Fix:** upgrade, then rebuild the agent, or stop and start it. Its `AGENTS.md` then has a **Google accounts** section naming the account and saying how to run `gog`, and telling it that a saved claim to the contrary is out of date. Then type `/new` in its chat and ask in plain words. If it still denies having the account, take the claim out of its `MEMORY.md` and try `/new` again. The plugin it offers is third-party and is not needed. An older agent keeps its old gog skill, because a build never overwrites a skill, and the section is what corrects it.
- **Fixed in:** `v2.172.1`
- **Code:** `src/openclaw/workspace.ts` — `googleAccountsSection`; `src/orchestrator/googleConnections.ts` — `attachedGoogleAccounts`; `src/orchestrator/provision.ts` — `syncDataSourceDocs`; `src/openclaw/skills.ts` — `GOG_SKILL_MD`

### After connecting a Google account again, an agent still fails with the old sign-in, while Connections says every agent is up to date
- **Check:** Settings → Connections shows the account with no agent needing a re-attach, yet the agent's Google calls fail as before the reconnect (an expired or revoked sign-in); its Setup log has `connection.materialized` for that account a little before the reconnect finished.
- **Cause:** the agent was importing the account's old sign-in (a rebuild, a wake or an attach) when it was connected again. The import was recorded as done when it ended, after the new consent, so it counted as current although it carried the old token.
- **Fix:** upgrade: the import is now dated by when it read the token, so the agent shows as needing a re-attach. Until then, detach the account from the agent and attach it again (or rebuild the agent).
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/googleConnections.ts` — `materializeConnection`; `src/store/store.ts` — `markConnectionMaterialized`; `src/api/routes.ts` — `'/v1/connections'`

### An agent's Connections says "None yet" for Google accounts it has
- **Check:** the agent is running and was signed into the account (it uses it, or Access lists it), and opening its Connections again a little later lists it.
- **Cause:** when reading the agent's list of accounts failed (the container was busy, or the read printed something else), the list was shown as empty instead of as unread, with no Disconnect buttons.
- **Fix:** upgrade: a failed read now says "Couldn't read which Google accounts it is signed into just now". Open the agent's Connections again in a moment.
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/connections'`; `src/orchestrator/googleConnections.ts` — `gogAccounts`

### A removed repo source still pulls or pushes
- **Check:** after removing a repo source, the agent still has `~/.openclaw/.ssh/<repo>_deploy`, or the trail shows `datasource.key_left`.
- **Cause:** the source's record was deleted first; if taking the key off the volume (or out of the secret store) then failed, nothing retried it.
- **Fix:** upgrade; the removal is recorded and retried at the agent's next start, wake or rebuild until the key is gone. Also delete the deploy key on the repo's host (its settings → Deploy keys): a copy outside Hatchabot stays trusted until then.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/provision.ts` — `scrubRemovedDataSources`; `src/api/routes.ts` — `/v1/agents/:id/data-sources/:dsId`

### A repo never clones: "The repo rejected this agent's deploy key", though the key is on the repo and Test passes
- **Check:** the source's card keeps the message after every rebuild, its trail shows `datasource.git_sync_failed` with "Permission denied (publickey)", yet **Test** on the row says the repo answered. In the agent's console: `ssh-keygen -y -f ~/.openclaw/.ssh/<repo>_deploy | ssh-keygen -lf -` and `ssh-keygen -lf ~/.openclaw/.ssh/<repo>_deploy.pub` give different fingerprints (`ssh-keygen -lf` on the key itself reads the .pub, so it shows the wrong one).
- **Cause:** a `<repo>_deploy.pub` (or `-cert.pub`) left beside the key, from a key made there before. ssh offers the key in the .pub file, not the one given with `-i`, so the host never sees the stored key. Test passes because it writes the key to a fresh folder.
- **Fix:** upgrade and rebuild: each sync removes the .pub and -cert.pub beside the key. Before upgrading: in the agent's console, `mv ~/.openclaw/.ssh/<repo>_deploy.pub ~/<repo>_deploy.pub.old`, then rebuild.
- **Fixed in:** `v2.167.0`
- **Code:** `src/orchestrator/gitSource.ts` — `buildGitSyncScript`, `probeGitSource`; `src/orchestrator/provision.ts` — `syncGitDataSources`

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

### An app from a repo went into a different agent, or with another repo's settings, than Install was pressed for
- **Check:** the app's page (App) on an agent shows an app you meant for another one, or the settings of a repo read later; it happened when the "Run an app" dialog was closed and opened again (on another agent, or with another repo read) while an install or a Read it was still under way.
- **Cause:** before v2.171.0 the dialog's Install read the agent, the repo and the form again after each step it waited on (attaching the Google account, its tests), and a repo read that answered late filled the dialog opened since; so a press finished on whatever the dialog showed by then.
- **Fix:** upgrade. Stop the app where it does not belong (its page → App → Stop app) and run it again on the agent it is for. Now a press acts on the agent, repo and values it was pressed for, a failure after the dialog closed is said in a toast, and a late read lands nowhere.
- **Fixed in:** `v2.171.0`
- **Code:** `web/index.html` — `appGo`, `appRead`, `appDlgGen`, `appReadGen`

### An app's on/off setting was switched on although its default is "false"
- **Check:** the app's manifest gives a `bool` field a default written as text ("false", "off", "no", "0"), and the "Run an app" form showed it ticked; the app's config holds `true` for it.
- **Cause:** before v2.171.0 the form ticked the box for any default that was not empty, and an untouched box was sent as on; the server reads those words as off.
- **Fix:** upgrade, and run the app again from its repo (its page → App → Run an app from a repo…) with the box as you want it.
- **Fixed in:** `v2.171.0`
- **Code:** `web/index.html` — `appRead`; `src/orchestrator/apps.ts` — `coerce`

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

### Check all flags nearly every agent: "Gateway is only bound to loopback. Set gateway.publicOrigin …" and "Gateway bound to "auto" (0.0.0.0) (network-accessible)"
- **Check:** the alert says "Health check: N settings to fix" with these two lines, on every agent that has a console (agents without one bind loopback and do not get the second); Overview → Check health lists them as warnings from `core/doctor/node-hosting-preconditions` and `core/doctor/security`.
- **Cause:** OpenClaw's `doctor --lint` reports how Hatchabot runs every agent. The gateway binds "auto" inside the container, behind the agent's password or the console proxy's sign-in, and the machine publishes its port to itself only. The loopback line is OpenClaw's device pairing, which Hatchabot does not use (it says "loopback" even for "auto"). Before v2.167.0 Check all listed both; they are now counted as known, like the plaintext-config warning.
- **Fix:** nothing to change on the agents; do not follow OpenClaw's advice here (`gateway.bind=lan` or `loopback` breaks the console). Upgrade and run Check all again; until then, read past these two and look at what else Check health lists (the "…" is the rest). An error, an unauthenticated bind, or any other bind still shows.
- **Fixed in:** `v2.167.0`
- **Code:** `src/orchestrator/health.ts` — `isMuted`, `doctorLint`; `src/openclaw/configWriter.ts` — `buildConfigCommands`

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

### After a move or an imported download, the agent has no setup fields, its app has no Update or Stop app, or its browser and event-triggered tasks are off
- **Check:** the copy was made by a release before `v2.168.0`; on the source the agent had setup fields (Setup), an app (Apps), or the browser or event-triggered tasks switched on.
- **Cause:** a full copy carried the volume but not the setup fields with their values and placeholder text, the app's record, or the per-agent switches (browser, event-triggered tasks, rich messages, group access, file limit). The import's second provision then wrote those switches off over the restored config.
- **Fix:** upgrade both servers, then move or download it again; a part that fails its own checks is left out and named in the log (`import.parts_dropped`). On an older copy, set the switches again, and install the app again from its repo.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/transfer.ts` — `exportAgent`, `importAgent`, `ManifestSchema`
### The runtime's tool list still shows the old image after a rebuild or a promote
- **Check:** `GET /v1/runtime/capabilities` (the Runtime list of tools) disagrees with `docker run --rm --entrypoint bash <image> -c '<tool> --version'` for the same tag.
- **Cause:** the probe was cached by the tag's name for the life of the service, and a rebuilt or promoted tag names another image.
- **Fix:** restart the service, or upgrade: since v2.160.0 the cache is keyed by the image id, so a tag that moved is probed again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/runtimeCaps.ts` — `probeImageCapabilities`

### Building the runtime image stops at once with "EMBED_ENGINE must be baked or none." when the install's folder has a space in its name
- **Check:** the install's path has a space (or another character a URL encodes); `node scripts/runtime-pins.mjs embed-engine 2026.9.8` prints nothing and exits 0.
- **Cause:** the pins tool decided whether it was run as a command by comparing its URL with its path, and in a URL a space is `%20`. It printed nothing, so the build had no engine rule.
- **Fix:** upgrade, or build from a path without a space. The tool now compares paths on disk.
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/runtime-pins.mjs` — `isMain`; `scripts/build-runtime-image.sh`

### A runtime image built with `NODE_IMAGE`, `CHANNEL_PLUGIN_VERSION` or `BAKED_PLUGINS` set is the stock image
- **Check:** the build printed "Pulling release …'s runtime image by its digest" and "Pulled …", with no `docker build`; the image's labels do not show what was asked for.
- **Cause:** for the release's own OpenClaw, the build pulled the published image unless the embedding plugin pin or engine was changed; the other build settings were dropped without a word.
- **Fix:** upgrade and build again. Any of `NODE_IMAGE`, `CHANNEL_PLUGIN_VERSION`, `BAKED_PLUGINS`, `PLUGIN_INSTALL` or `LLAMA_CPP_PROVIDER_VERSION` now builds locally, and says so. For the OpenClaw version the release publishes, such a build gets a tag of its own (`<version>-custom-<checksum>`, as extra packages get `-plus-…`), so agents pinned to the plain version tag keep the standard image: pin an agent to the new tag to try it, or set `IMAGE_TAG` to name it yourself. For another OpenClaw version the settings are how its image is made to build, and it keeps the version tag. Before that, `BUILD_LOCAL=1` forces the local build (onto the plain tag).
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/build-runtime-image.sh`

### Building an image with extra packages replaced another image with extra packages
- **Check:** two package lists start with the same forty characters (once spaces become dashes); `docker images hatchabot-runtime` shows one `…-plus-…` tag where there should be two, and agents pinned to the first image get the second list's packages after a rebuild.
- **Cause:** the image's tag carried only the first forty characters of the list, so two such lists had the same tag, and the second build moved it.
- **Fix:** upgrade, then build the first list again and pin its agents to the new tag. A list longer than the tag shows now ends in a checksum of the whole list; short lists keep their tags.
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/build-runtime-image.sh`

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

### Bulk actions → Class gave the agents different classes, or cleared some
- **Check:** you applied a class to several agents and changed the class menu (or opened Bulk actions again) before it finished; agents later in the list have the other class, or none.
- **Cause:** the class was read from the menu again for each agent, and the menu stayed usable while Apply worked.
- **Fix:** apply the class again to the agents that got the wrong one. Since v2.168.0 the class is read once, when Apply is pressed, as the model and image already were.
- **Fixed in:** `v2.168.0`
- **Code:** `web/index.html` — `faApply`

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


### After changing an agent's model, source or image, it keeps its old class's memory cap
- **Check:** the change said the agent left its class (`classDetached`), but `docker inspect -f '{{.HostConfig.Memory}}' <container>` still shows the class's cap, while its Overview shows the machine's default or its own.
- **Cause:** a change that drops the class by itself left the container on the class's memory cap and swap until a rebuild. Taking the class away by hand applied the new limits.
- **Fix:** upgrade: when the class it left sets a memory cap or a swap allowance, the limits that now apply (its own or the machine's default, whatever its old class says by then) go on the container at once (a class with neither leaves the container alone), or, when a rebuild is under way ("Switch these agents" with a rebuild), on the container it makes. A container that refuses them is said: the app names the agent after a model change, "Switch these agents", "Move agents here", "Migrate all" and a source's new default, and the manager's `set_model` receipt says it too (`memoryPending`), a refused model included; its timeline has `memory.limits_kept` with the container's own reason, the same from every class path (leaving, joining, a class edited or deleted). An agent with both a cap and a swap allowance of its own is left alone: its limits never came from the class, so there is nothing to put on and no warning. In "Switch these agents", "Migrate all" and a source's new default, each agent's limits go on in its own turn, all at once rather than one after another, so a runner asleep does not make a batch wait for each in turn. Setting the agent's own cap or swap goes through the same step: when its machine is gone or not answering (a runner asleep), the value is kept as its own and that is said the same way (the app: "kept for its next start"); when its machine answers but the value does not go on (docker refuses it, a cap below what it uses now, or any other error there), the change answers an error and nothing is stored, so no later rebuild puts it on. A save of both whose swap allowance is refused after the cap went on stores neither, and puts the container back on the limits it had: an agent's settings saved together are stored all at once (HB-0570). Until then, rebuild the agent or set its memory cap.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `detachClassIfDrifted`, `limitsAfterDetach`, `applyCurrentLimits`, `setMemoryCap`, `setSwapAllowance`, `switchAgentToSource`, `limitsSaid`; `web/index.html` — `leftClassKeptLimits`, `applyModelToSelected`, `saveMemoryCap`, `saveSwapAllowance`; `src/mgmt/apiClient.ts` — `setModel`

### An agent sizes its jobs to its old memory cap after a class changed it
- **Check:** the agent's AGENTS.md "Memory budget" section names a cap other than the one on its Overview, after it was put in a class, taken out of one (by hand, or by a change of its model or source, one agent or many, or a source's new default), or its class's cap was changed or the class deleted.
- **Cause:** a class applied the new cap to the container but did not tell the agent; setting its own cap did.
- **Fix:** upgrade: a running agent whose cap a class moved has its Memory budget section rewritten, and nothing else, without holding up a Rebuild or a model change asked for meanwhile; a save of AGENTS.md made while it works is kept, and the budget is written into the saved file (staged beside it only in the turn a save takes, never left waiting there), every byte outside the section as it was, one that is not UTF-8 included. Written for a change of its cap while it runs, the section says the cap it has now, and that `HATCHABOT_MEMORY_CAP` in its environment keeps the value from its container's last start until a rebuild; a section that already says its cap, in either wording, is left as it is, by this and by other updates of AGENTS.md, and one that does not is written in those live words by any update made while it runs (only a fresh start or a rebuild writes "also in the environment"). One stopped or asleep when its cap changed is told once Start, or a wake, has it up. It is told only when the new limits went on its container, its own cap set by hand included: a cap stored while its container kept the old one (a runner asleep) is not told as its budget. Each agent is told on its own: one busy at the time (a backup, a move) once it is free, for up to 30 minutes (past that, `memory.budget_not_told` in its timeline, and the next change of its cap tells it; one asked while it waited is not dropped), one being rebuilt once the rebuild is done, one waiting to switch source now (the budget is its container's). One that could not be told (its machine gone) has `memory.budget_not_told` in its timeline, and the next change of its cap tells it. Until then, rebuild it, or set and clear its own cap.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `tellMemoryBudget`, `limitsTold`, `capMovedFrom`, `withAgentsMdTurn`, `detachClassIfDrifted`, `startStopped`; `src/orchestrator/busy.ts` — `busyDone`; `src/orchestrator/provision.ts` — `syncMemoryBudget`, `syncDataSourceDocs`; `src/orchestrator/snapshots.ts` — `writeFileInAgent`; `src/orchestrator/memoryCap.ts` — `memoryBudgetSection`


### A restored or moved agent has less memory than it had: its class gave it more
- **Check:** the agent was in a class with a memory cap or swap allowance, and had none of its own; after the import it runs on the machine's default (3 GB unless set).
- **Cause:** a downloaded copy carried only the agent's own memory cap and swap, and the class does not travel.
- **Fix:** upgrade on the machine that makes the copy. Until then, set the agent's own cap (its sheet → Runtime → Memory cap) after the import. Since this release the copy carries the class's budgets when the agent has none of its own, held to the destination's rules.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/transfer.ts` — `exportAgent`, `importedLimits`

### A file or folder downloaded from Files is short, or its `.tar.gz` will not open ("unexpected end of file")
- **Check:** the download is smaller than the size Files lists, and the service log shows the agent's machine or Docker failing at that time.
- **Cause:** the copy out of the agent's volume could fail part-way (the machine went to sleep, Docker stopped, a read error), and the download still ended as if it were complete.
- **Fix:** upgrade: a copy that fails now breaks off the download, so the browser reports it as failed instead of saving a short file. Download it again once the machine answers.
- **Fixed in:** `v2.160.0`
- **Code:** `src/providers/localDockerProvider.ts` — `streamFromVolume`

### `hatchabot get <agent> .` fails instead of saving the agent's home folder
- **Check:** the path given was `.`, `/`, `./` or began with `./` (`./notes/`), and the error came from the file download ("That is a folder" or "No such file or folder").
- **Cause:** the CLI looked for an entry literally named "." in the folder listing, found none, and asked for a single file, where the server reads `.` as the home folder.
- **Fix:** upgrade; `.` and `/` download the whole home folder as `<agent>.tar.gz`, and `./` parts are dropped as the server drops them. On an older version, give the folder's name without `./`, or download the home folder from the agent's Files tab.
- **Fixed in:** `v2.171.0`
- **Code:** `src/cli.ts` — `'get'`; `src/orchestrator/agentFiles.ts` — `cleanRelPath`

### An earlier copy of a file was lost when `hatchabot get` or `hatchabot backup` failed part-way
- **Check:** the command ended with an error (a dropped connection, the agent's machine went to sleep, Ctrl-C), and the file named by `--out` that was there before is now short or empty.
- **Cause:** the download was written straight over the destination, which was emptied before the first byte arrived.
- **Fix:** upgrade; a download goes to a hidden `.<name>.<random>.part` file beside the destination and replaces it only once complete, so a failed one leaves the earlier copy as it was. In a folder you cannot add files to, a file there you may write waits as `hatchabot-<random>.part` in the temp folder and is copied over it once complete. A pipe or a device (`--out /dev/stdout`) has nothing to replace and is written directly. A `.part` file left by a killed command can be deleted.
- **Fixed in:** `v2.171.0`
- **Code:** `src/cli.ts` — `saveTarget`

### A download from Files never starts or never finishes, and the browser just waits
- **Check:** the download shows no progress for minutes; the agent's machine is a runner that went to sleep or lost its connection, or `docker ps` shows a `<prefix>-fs-…` container that stays up.
- **Cause:** a download had no deadline: a Docker daemon or runner that stopped sending, without ending the copy, held the download (and its container) for as long as the browser waited.
- **Fix:** upgrade: a download that receives nothing from Docker for two minutes is broken off, the browser reports it as failed, and its container is removed. A slow download that keeps moving, or a slow browser, is not cut off. Try again once the machine answers.
- **Fixed in:** `v2.162.0` (#217)
- **Code:** `src/providers/localDockerProvider.ts` — `streamFromVolume`, `STREAM_STALL_MS`

### An upload whose name starts or ends with a space replaced a different file
- **Check:** the file you uploaded was named with a leading or trailing space (` notes.md`), and the agent's `notes.md` now holds its content.
- **Cause:** the upload trimmed the spaces from the name, so it landed on the file without them.
- **Fix:** upgrade: the name is kept exactly as given. Restore the overwritten file from a backup if it mattered.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/agentFiles.ts` — `cleanFileName`


### A picture with a long file name opens as text in Files
- **Check:** the file's name is over 120 characters; a shorter copy of it opens as a picture.
- **Cause:** the name was cut to 120 characters before its type was read from it, so the `.png` (or `.jpg`, `.pdf`) was cut off and the file was sent as text.
- **Fix:** upgrade: the cut keeps the extension. Or rename the file shorter.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/agentFiles.ts` — `downloadName`, `inlineType`

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

### Looking inside an archived agent whose volume is gone shows an agent with no files, and an empty volume appears
- **Check:** `docker volume inspect <agent's volume>` said "no such volume" before you looked, and an empty volume of that name exists after.
- **Cause:** the read-only look mounted the volume by name, and Docker makes a volume that is not there, empty. The view then showed no files instead of saying they were gone.
- **Fix:** upgrade; a read-only look asks for the volume first and says "This agent's stored files are not on its machine: its volume is gone." If you need its files, restore it from the archive, which makes a new, empty volume, then restore it from a backup set. Remove an empty volume made this way with `docker volume rm`.
- **Fixed in:** `v2.171.0`
- **Code:** `src/providers/localDockerProvider.ts` — `execShellOnVolume`; `src/orchestrator/inspect.ts` — `InspectReadError`
### Looking inside an archived agent: Chat history says "No conversation found on the volume", or shows a background task instead of the chat
- **Check:** the agent ran OpenClaw 2026.9 or newer (its chat is in `agents/<slug>/agent/openclaw-agent.sqlite` on the volume, and Data → History finds it); or its `sessions/sessions.json` names a main conversation other than the biggest `.jsonl` file there.
- **Cause:** the viewer read only the 2026.7 `.jsonl` files, took the biggest one (often a scheduled task's) rather than the main conversation, and showed a folder it could not read as no history.
- **Fix:** upgrade: the viewer reads the main conversation (`agent:<slug>:main`) from the agent's database, else the one `sessions.json` names, and says when the store cannot be read ("Couldn't read the agent's chat history:" with the part and the reason, such as a damaged database or `EACCES`). A main conversation that a reset emptied just before archiving is said to be empty ("Its main conversation is empty"), never shown as another one. Until then, Data → History downloads the whole chat.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/inspect.ts` — `readTranscript`, `TRANSCRIPT_TAIL_SCRIPT`

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

### A task added just as the agent went to sleep never ran
- **Check:** the agent is asleep (its tile says so, or `hatchabot events <agent>` has `agent.hibernated`) and its Schedule tab has a task switched on that was added within a few seconds before that; the task's runs list is empty since.
- **Cause:** putting it to sleep (by hand or after its quiet period) read the task list before taking the agent's lock, so a task added during that read was accepted and the agent was stopped with the older, empty list.
- **Fix:** upgrade; the list is read again under the lock that adding a task takes, so the task is either refused ("Another operation is already running", try again) or keeps the agent awake. Wake the agent so its task runs.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/hibernate.ts` — `hibernateAgent`, `NoLongerSleepy`; `src/api/routes.ts` — `'/v1/agents/:id/hibernate'`

### A sleeping agent did not wake for the first message after the service restarted
- **Check:** the service restarted within seconds of `agent.hibernated` on the timeline; the first Telegram message sent after that waits unanswered until another message comes or the agent is started.
- **Cause:** a restart between the stop and the reading of what was already waiting left a placeholder mark. The next wake check took everything waiting then, including messages sent after bedtime, as already handled.
- **Fix:** upgrade: the mark is recovered by the time the agent went to sleep, so a message sent after it wakes the agent. On older releases send another message or start the agent.
- **Fixed in:** `v2.162.0`
- **Code:** `src/orchestrator/hibernate.ts` — `telegramHasMail`, `markBefore`

### A sleeping agent answers on its old build after a change that needs a rebuild
- **Check:** the agent's tile shows a required rebuild, the machine's sleep time (`HATCHABOT_HIBERNATE_AFTER`) is 10 minutes or less, and the timeline shows `agent.hibernated` and wakes but no rebuild.
- **Cause:** a wake starts an agent as it is, and the machine's own rebuilds only rebuild running agents idle for 10 minutes; with a short sleep time the agent fell asleep again first, every time.
- **Fix:** upgrade: an agent waiting for a required rebuild is not put to sleep until the rebuild has run (unless rebuilds are set to manual, where nothing would rebuild it). Before that, press Rebuild on the agent.
- **Fixed in:** `v2.169.0`
- **Code:** `src/orchestrator/hibernate.ts` — `idleBlocker`, `requiredRebuildDue`; `src/api/routes.ts` — `hibernateDeps`

### An agent set to "Never sleep" was put to sleep anyway
- **Check:** `agent.hibernated` on the timeline, by the idle sweep (`quiet for … min`), seconds after its sleep setting was changed to never.
- **Cause:** the idle sweep read the setting before it read the agent's activity and tasks, and stopped it without looking again. Until v2.171.0 the look again came before the stop's own last reads (its tasks, its activity), so a change saved during those still lost.
- **Fix:** upgrade: the setting is judged again in the same moment as the stop. Start the agent; it stays up.
- **Fixed in:** `v2.162.0`; `v2.171.0` for a change saved during the stop's last reads
- **Code:** `src/orchestrator/hibernate.ts` — `hibernateAgent`, `settledBlocker`

### ✨ Ideas in the icon dialog never offers the icon you have in mind
- **Check:** the ideas are only 🤖, or nothing like what you want, or there are none on any agent, every time, even though the AI works elsewhere. The note under them says which: none of your sources can make ideas; the management AI didn't answer (the call failed: it was busy, out of its limit, or could not be reached); or the management AI answered but no ideas could be read from its answer. Before the fix, that last one also read "didn't answer". On the machine, `journalctl --user -u hatchabot --since "-1 day" | grep "icon ideas"` gives the AI's error, or for a reply with no ideas `"error":"its answer held no emoji"` and the reply's shape, never its text: `length`, `bracket` (it held a `[`), `entries` (how many could be read), `toolShaped`, `cutOff`, and `stopReason` where the source gives one. `grep "agent icons"` gives the same for the home screen's automatic picks, which fall back to the keyword table per agent.
- **Cause:** the ideas came from the AI's reading of the name alone, with no way to say what you wanted; when the AI didn't answer, the keyword table stood in, and it knew no seasonal or everyday words ("Holiday list" matched nothing). A reply that held usable ideas could also be lost: the parser read from the first `[` to the last `]` as one piece of JSON, so a stray bracket, a trailing comma or a cut-off reply gave nothing, and on a Claude plan's source (a setup token or the machine's login) the prompt also told the model about calling tools and replying in plain prose, which goes against "JSON only", and a reply shaped like a tool call came back empty.
- **Fix:** upgrade, then type what it should show ("a birthday cake") in **What should it show?** and press ✨ (or Enter); that box came in `v2.170.0`. Any emoji can also be pasted straight into the Emoji box. Since the fix the parser reads a reply's entries one by one, from any array in it, and a source with no tools gets no tool protocol. If the note still says no ideas could be read, the log line's shape says what came back: `cutOff` means the reply was too long for its limit (the source's own stop reason says so; with no stop reason, an array ran out at the end of the text); a short `length` with no `bracket` means something other than the ideas came back, so try another model for the source under ⚙ Settings → AI sources.
- **Fixed in:** `v2.172.0`
- **Code:** `src/orchestrator/agentIcons.ts` — `suggestIcons`, `pickIcons`, `parseIdeas`, `replyArrays`, `replyShape`, `keywordIcon`; `src/api/cliChatModel.ts` — `completeViaCli`; `src/api/routes.ts` — `iconCompleter`; `web/index.html` — `v2IconIdeas`

### Two of your agents have the same name, and the command line says the name "matches more than one"
- **Check:** the app lists two agents of yours with one name (case aside); one was renamed to it, with a memory change in the same save, at about the time the other was renamed to it or made.
- **Cause:** the rename checked for the name before it waited on the memory change, and another rename, or a new agent, passed the same check during that wait.
- **Fix:** rename one of them. Since the fix a name being given to one agent is held until that save answers, and a second rename to it, or a new agent with it, is refused.
- **Fixed in:** `v2.171.0`
- **Code:** `src/api/routes.ts` — the `'/v1/agents/:id'` patch route, `holdOnce`

### After a restart during a rebuild, the agent runs but its repo, rebuild hook or waiting scheduled tasks are missing
- **Check:** the rebuild's operation says "it was running again, so it is marked running"; the agent's Data tab shows a repo never synced, or Tasks lacks a task its template promised, and the timeline has no `runtime.rebuilt` for it.
- **Cause:** a rebuild cut off after its new container came up was marked done on the container's health alone, so the steps after health (repos, connections, docs, context cap, rebuild hook, memory index, waiting tasks) never ran.
- **Fix:** Rebuild the agent. Since the fix the recovery runs those steps first and then marks it running ("the rest of its rebuild ran again").
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/operationsResume.ts` — `resumeBackground`; `src/orchestrator/provision.ts` — `finishRebuild`, `finishInterruptedRebuild`

### "Try again" on a held setup or rebuild always says "It is busy with this already"
- **Check:** Alerts shows the agent's setup or rebuild held with "Putting it right after a restart failed", its container is up and healthy (`docker ps`), and every Try again answers "It is busy with this already — wait a moment."
- **Cause:** Try again runs under the agent's busy flag, and the restart rule for a setup (and a rebuild) whose container is up took that flag a second time, so it refused itself.
- **Fix:** Retry the setup, or Rebuild the agent, from its page. Since the fix Try again settles it.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/operationsResume.ts` — `recoverOperation`, `resumeBackground`; `src/orchestrator/provision.ts` — `runProvisionSteps`, `finishInterruptedRebuild`

### A folder in the Data tab says "is a file, not a folder" when tested
- **Check:** Settings → Data → Test on the folder answers "… is a file, not a folder"; the path it names is a single file.
- **Cause:** adding a folder checked only that the path existed, so a file's path was saved as a folder.
- **Fix:** remove it and add the folder the file is in. Since the fix a file's path is refused when it is added.
- **Fixed in:** `v2.171.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/data-sources'`
### A git data source removed while it was syncing still has its deploy key on the agent, though removing it said the key was taken off
- **Check:** the repo source was removed while its sync was running (just after it was added, a Rebuild or a start); removing it answered that the key was taken off, and `data_source_removals` in the store is empty, yet in the agent `ls ~/.openclaw/.ssh/<mount>_deploy` finds the key and the clone can still pull.
- **Cause:** the sync had read the deploy key before the removal and wrote it to the volume after the removal had scrubbed it, and nothing was left to retry the scrub.
- **Fix:** upgrade. A sync and a removal of one agent's repos now take turns, and a sync writes a key only for a source still there. For a key left by this, add the repo again and remove it once more (or in the agent, `rm -f ~/.openclaw/.ssh/<mount>_deploy*`), and delete the deploy key on the git host as the page says.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/provision.ts` — `inGitAccessTurn`, `syncGitDataSources`, `scrubRemovedDataSources`

### After moving an agent to another machine, a git data source removed earlier still has its deploy key there
- **Check:** removing the repo said its key could not be taken off yet (the agent was restarting or its machine not answering), so `data_source_removals` in the store still lists it; the agent was then moved, and on the new machine `ls ~/.openclaw/.ssh/<mount>_deploy` in the agent still finds the key.
- **Cause:** a scrub left to do was retried at a start, a wake or a rebuild, and a move runs none of them: the key rode the copied volume and the moved agent could still use it.
- **Fix:** upgrade: a move scrubs what is left on the copied volume before the agent starts on the new machine, and records it done once the move is settled (a move undone leaves it recorded for the source's next start). For an agent moved before, Stop and Start it (the start retries the scrub), and delete the deploy key on the git host as the page says.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/moveHost.ts` — `completeOnTarget`, `scrubRemovedDataSources`

### An app reads a single address where its setup field should be a list, or an install says a field "is filled from …, which is not …"
- **Check:** the app's `hatchabot.json` has a field with `from` (filled by Hatchabot) and a `type`; in the agent, its config file holds that field as a plain string, e.g. `"recipients": "owner@…"` for a `list` field. Or an install or update stops with "is filled from …, which is not …".
- **Cause:** a value Hatchabot filled in was written as it was, not as its field's type, so a list filled from the owner's address was a string the app could not read as a list.
- **Fix:** upgrade and Update the app: the filled value is written as its field's type (a list of one address, a number for a `number` field filled from `owner.telegram`). A filled value that does not fit its field's type (an email field filled from the agent's name) stops the install or update with what to fix in the manifest.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/apps.ts` — `mergeConfig`, `coerce`

### Installing an app took off the owner's own scheduled task of the same name (`<app>-<task>`)
- **Check:** the owner had a task named exactly like one of the app's (`<app>-<task>`, e.g. a reminder they made by hand); after the app was installed, updated or stopped, that task is gone, and only the app's command task of that name is in `openclaw cron list --all --json`.
- **Cause:** an app's tasks were found by their name alone, so any task with that exact name was taken for the app's and replaced or removed with it.
- **Fix:** upgrade: only command tasks of the app's names are the app's; a reminder or agent turn with the name is left alone, beside the app's. A task taken off before is gone: add it again in the Schedule tab (another name avoids confusion).
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/apps.ts` — `appJobs`, `syncTasks`, `removeTasks`

### An app's required list was saved empty: given as blank items, it was not asked for
- **Check:** the app's config file holds a required `list` field as `["", " "]` (or with blank items among the real ones), and the app runs with no recipients; it was set from the API or CLI with blank items rather than as `a, b`.
- **Cause:** a list given as items was taken as it was, while the same list typed as text (`" , "`) was trimmed and found empty.
- **Fix:** upgrade: items are trimmed and blanks dropped, so a list of only blanks is asked for again; Update the app with the values.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/apps.ts` — `mergeConfig`, `coerce`

### Runtime images: "Used by" says "nothing" but deleting the image is refused
- **Check:** `docker ps -a --filter ancestor=<tag> --format '{{.Names}}\t{{.State}}\t{{.Image}}'` lists a container, often an archived agent's stopped one. Or the image is held by an archived agent's pin, an agent's pin on a runner, another account's class, or a derived image built on it.
- **Cause:** the list and the delete checked different things. The list read only this account's classes and the pins of live agents on this machine, and no containers; the delete also counted the rest, and Docker's refusal named nobody.
- **Fix:** upgrade: "Used by" then lists everything that holds the image and how to clear it, and a refused delete says the same. Until then, clear what the Check finds: restore an archived agent and rebuild it on another image, or delete it. A container with no agent goes with `docker rm <name>`. Docker removes a tag freely when another tag shares its image, so a container only holds the image's last tag.
- **Fixed in:** `v2.172.0`
- **Code:** `src/api/routes.ts` — `imageBlockers`; `src/providers/localDockerProvider.ts` — `imagesInUse`; `web/index.html` — `renderRuntimeList`

### An agent that fails again stays under Fine, or the Hatchabot agent's tile says Ready with its safety settings changed
- **Check:** the agent was earlier **Clear**ed from Alerts for the same kind of thing. Its page shows "Cleared from Alerts" with **Show again**, while the failure, the waiting step or the changed safety settings are new.
- **Cause:** the Clear was stored by kind (`failed`, `pending`, `opsDrift`, `restart:1`), and nothing removed it when the thing ended, so the next one of that kind counted as already cleared.
- **Fix:** upgrade: a Clear now ends with what it cleared. A failure ends when the agent leaves that state or fails anew, a waiting step when it is done, and restarts, memory hits and changed safety settings when a new container is made. On a release before this, or for a Clear left from one, press **Show again**.
- **Fixed in:** `v2.173.0`
- **Code:** `src/store/store.ts` — `dropAttentionAckKeys`; `src/orchestrator/provision.ts` — `recordApplied`; `web/index.html` — `attentionCleared`, `attentionFingerprint`

### Archive said "its bot is back in the pool", and the pool does not have it
- **Check:** the agent had a copy downloaded and stood stopped since (Settings → Messaging → Telegram → Bot pool does not list its bot). Or it never had a bot: it was web-only.
- **Cause:** the dialog and the message after were fixed words. A bot is left to a downloaded copy, which may be talking on it, instead of being parked.
- **Fix:** nothing to repair: the bot was not lost, it is the copy's. To use it here anyway, **Add to pool** with its token (Settings → Messaging → Telegram). Upgrade for words that say which happened.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `archiveBotWords`, `confirmArchive`; `src/orchestrator/archive.ts` — `copyElsewhere`, `leaveBotToCopy`

### Report a problem: a draft is gone from Drafts after pressing Open on GitHub
- **Check:** you pressed **Open on GitHub** and did not press Submit there (a closed tab, or not signed in to GitHub). The report is still on the server: the agent's link to it (`/#report=<id>`) opens it.
- **Cause:** opening the tab marked the report as sent, and the list showed only unsent ones. The page cannot see whether Submit was pressed.
- **Fix:** upgrade: an opened report stays in the list, marked "opened on GitHub", until you discard it.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `reportOpenIssue`, `reportLoadDrafts`

### Report a problem replaced text typed while it saved, or closed a draft opened meanwhile
- **Check:** in Report a problem, you kept typing while Copy, Save as a file or Open on GitHub was saving, and your last words disappeared. Or you pressed Discard and opened another draft before it finished, and that draft closed.
- **Cause:** when the save answered, its masked text replaced the fields as they were at that moment. The discard closed whichever draft was open when it finished.
- **Fix:** type the lost words again, or open the draft again from the list. Since the fix, a field typed in during the save keeps what you typed, and that is saved too (and masked) before Copy, the file or GitHub goes on. If you are still typing through that second save, nothing goes out, and a note asks you to press the button again. A discard closes the draft only if it is still the one shown; if you opened that same draft again while it was being discarded, it closes once it is gone, and is not drawn when its load comes.
- **Fixed in:** `v2.178.0`
- **Code:** `web/index.html` — `reportSaveEdits`, `reportDiscard`, `reportLoading`

### The Schedule tab still says "It is stopped — start it" after pressing Start
- **Check:** the bar shows the agent running; another tab and back shows the tasks.
- **Cause:** the agent page's tabs of edit sections (Personality, AI, Data, Telegram, Sharing, Schedule, Advanced) were drawn once for the state they opened in, and the poll repainted only the bar.
- **Fix:** upgrade: the tab redraws when the state changes. It waits while a field is in use, and while a control in the page's forms holds something other than what it held when it was filled or last saved, a setup field added or removed and a task being edited included, so an unsaved edit is not lost. Before `v2.178.0` a change that was saved (a Telegram token Connect used, or a setting that saves itself, such as the memory limit) held it too, until the page was closed; so did an edit left on another agent's page before this agent's Schedule tab was opened, a file in the Personality tab's editor that would not load, and a save answered after the page was closed and opened again. On an older release, change tab and back.
- **Fixed in:** `v2.173.0`; a saved change no longer holds it: `v2.178.0`
- **Code:** `web/index.html` — `v2RefreshSheet`, `v2RenderSheet`, `v2EmbedPanes`, `v2SheetNotes`, `v2SheetBaseline`, `v2SheetSaving`, `v2SheetUnsaved`, `editParamsSaved`, `loadEditFile`

### Planned: pressing Add clears the box and nothing appears
- **Check:** an agent you can see already has that name, in any capitalisation, including an archived one or one shared with you.
- **Cause:** a plan was deleted as "made" as soon as any visible agent carried its name, however old, and adding one never checked.
- **Fix:** upgrade: a name one of your own agents already uses, archived ones too, is refused with a message, and a plan goes only when your own agent of that name was made after it. On an older release, plan a different name.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `todoIsMade`, `addTodo`, `loadTodos`; `src/api/routes.ts` — `/v1/agent-todos`

### An archived agent dragged onto a group came back in its old group
- **Check:** you restored it by dragging it from Archived onto a group or the new-group strip, and it stands in the group it was in before, with no new group made.
- **Cause:** the drop restored it and stopped there, before the part that moves it.
- **Fix:** upgrade: it is restored, then moved to the group it was dropped on, and the strip makes the new group. On an older release, drag it once more now that it is back.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `restoreAgent`, `v2DropTarget`

### Pin & rebuild or a bulk rebuild started an agent that had just stopped
- **Check:** the agent stopped or went to sleep moments before, and its Activity shows a rebuild right after, ending with it running. The page still showed it running when you pressed, or the question stayed open a while.
- **Cause:** the page checked its own last reading of the agent's state. The rebuild asked of the server was the kind that starts a stopped agent, as a Rebuild pressed by name does.
- **Fix:** upgrade: these rebuilds ask the server to leave a stopped agent down, and it takes the change at its next start. On an older release, stop it again; what it was to carry is already in place.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `saveImagePin`, `faApply`, `rebuildAll`; `src/api/routes.ts` — `'/v1/agents/:id/rebuild'`

### Apply values brought back an old description (persona) after a file was saved
- **Check:** the agent's description went back to an older one after Apply values, and you had changed the description while a SOUL.md or AGENTS.md save, a merge of a learning, a push of its master's definition, or Apply values itself was under way.
- **Cause:** each of those wrote the whole setup layer back as it had read it before its wait, which put the old description back into the layer; Apply values also rendered the description from the layer it read at the start. Apply values renders from the layer.
- **Fix:** set the description again. Since the fix, each writes only its own file into the layer, in one step, and Apply values renders the description from the layer as it is then. A description changed meanwhile that the new values would make too long is left as it is, and Apply values says so ("Values applied, but ⚠ …").
- **Fixed in:** `v2.178.0`
- **Code:** `src/store/store.ts` — `setAgentParamFile`; `src/api/routes.ts` — `'/v1/agents/:id/files/:name'` (PUT), `'/v1/agents/:id'` (PATCH), `'/v1/agents/:id/params'`, `'/v1/agents/:id/proposals/:pid/resolve'`, `'/v1/agents/:id/push-definition'`; `web/index.html` — `saveSetupValues`, `resetSetupValues`

### A snapshot holds a SOUL.md and an AGENTS.md that never went together
- **Check:** a named snapshot's files read as part old setup values and part new ones; it was taken while setup values were applied or a snapshot was restored.
- **Cause:** taking a snapshot reads the files one at a time and did not wait for an edit that writes several.
- **Fix:** take the snapshot again, and don't restore the mixed one. Since the fix, a snapshot taken by hand and a change that writes core files (setup values applied, a definition pushed to the agent, a snapshot restored, a file saved, a proposal merged into a master's playbook) take turns: each waits for the other to finish, and a snapshot after such a change holds its setup values and layer with its files. A snapshot that waited looks at the agent again: one archived, stopped or deleted meanwhile is refused in those words. The changes that waited do too: Apply values renders from the files, fields and values as they are when its turn comes (a SOUL.md saved meanwhile is kept, and a field a push added meanwhile keeps its value, a reset too: a reset puts back only the fields it showed), a pushed definition keeps the values a child was given meanwhile, and a restore of an agent moved meanwhile is refused ("It moved while this waited; restore again."). One that waits more than two minutes is refused ("Another change to its files is still running; try again when it ends.") and does not run later; a push works on four children at a time, waits for their turns until one deadline two minutes from its start, and reports a child it could not reach as not pushed; a child waiting for one of the four does not hold its files up meanwhile. A snapshot asked for during a change that replaces its files (a rebuild, a move, an archive, a restore, an app update or rollback), when they may be half replaced, is refused ("It is busy (a rebuild); take the snapshot when that ends.", or the change's own words) and takes nothing. Other work on the agent, such as a backup, a task switched on or an app install, does not hold a snapshot up. A change that replaces the files and begins while a snapshot taken by hand reads them (a Rebuild pressed then) goes ahead, and the snapshot is not stored ("A rebuild or restore started while the snapshot read its files; take it again."). One started again after a restart counts the same. A file saved while a snapshot reads waits for it, so the snapshot keeps each file with the layer it goes with.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `withCoreFilesTurn`, `'/v1/agents/:id/snapshots'` (POST), `'/v1/agents/:id/files/:name'` (PUT), `'/v1/agents/:id/params'`, `'/v1/agents/:id/push-definition'`, `'/v1/agents/:id/snapshots/:snapId/restore'`, `'/v1/agents/:id/proposals/:pid/resolve'`, `freshRunning`; `src/orchestrator/operations.ts` — `FILES_REPLACED_BY`, `noteFilesReplacing`, `filesReplacingCount`; `src/orchestrator/operationsResume.ts` — `runKind`; `src/orchestrator/snapshots.ts` — `captureSnapshot`

### A stopped agent connected to others still cannot consult them after Start
- **Check:** you connected agents to each other (the bulk Connect, or an agent's Peers tab without its Rebuild), or deleted one it could consult, while it was stopped or asleep, and after you started it its icon still says it needs a rebuild for its peers.
- **Cause:** the page promised that a stopped agent picks the change up when it next starts, but nothing marked its next start as the rebuild that installs it.
- **Fix:** rebuild that agent. Since the fix, when you press Start it rebuilds any agent whose peers are not the ones it has installed, however they changed (connected or removed while it was stopped, a peer deleted, a change made during an operation); peers put back as they were mean a plain start. A sleeping agent is different, by design: it wakes for a message as it was, so the message is answered at once, and an agent a budget pause lets go of starts as it was too. It takes new peers at its next Start or Rebuild; until then its card says its peers changed, and the bulk Connect's answer names it as asleep. An agent deleted, or being deleted, while the bulk Connect works is not named at all.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `peersNotInstalled`, `rebuildOwedAtStart`, `startStopped`, `'/v1/agent-peers/mesh'`, `'/v1/agents/:id/peers'`; `src/store/store.ts` — `peersCsv`, `agentsWithPeersPending`

### A master's playbook has the same distilled learning twice
- **Check:** the master's AGENTS.md has two `<!-- distilled from … -->` blocks with the same text. The first merge failed with an error (its machine was slow, or its link dropped), and the merge was tried again.
- **Cause:** the write landed but its answer was lost, so the proposal went back to waiting, and the retry appended it again.
- **Fix:** delete the second block (Files, or ask the agent). Since the fix, each block carries its proposal's id, and a merge whose block is already there does not write it again.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/proposals/:pid/resolve'`

### `hatchabot adopt` timed out or failed, and the agent it made is still there
- **Check:** `hatchabot list` shows the agent named in the failed adopt. The adopt ended with "still PROVISIONING after N min", or said the agent "was cleaned up".
- **Cause:** running out of `--timeout` ended the command before its clean-up, and a removal the server refused (the agent was still being set up, or the server was gone) was not checked: adopt said the agent was cleaned up anyway. Running adopt again then collided with it.
- **Fix:** upgrade: a timeout removes the half-made agent too, and a removal that fails is said, with the agent's id and `hatchabot delete <id> --yes`. On an older release, delete it yourself, then run adopt again.
- **Fixed in:** `v2.178.0`
- **Code:** `src/cli.ts` — `'adopt'`, `pollAgent`, `StillWaiting`

### `hatchabot archive` said "its bot is back in the pool", but the bot is not in the pool
- **Check:** the agent's bot was one you pasted, or a copy of the agent was downloaded while it was stopped; the pool (`hatchabot bots`, or Settings → Telegram) does not list the bot.
- **Cause:** the CLI printed the same line after every archive, whatever happened to the bot: parking a pasted bot can fail, a bot can be left to a downloaded copy, and a web-only agent has none.
- **Fix:** upgrade the server and the CLI: the CLI prints what the server says happened ("its bot @… could not be put back in the pool; to use it again, paste its token into an agent"). Against an older server it still prints the old line.
- **Fixed in:** `v2.178.0`
- **Code:** `src/cli.ts` — `'archive'`, `archivedBotLine`

### Every new agent fails to start, and rebuilds fail too, after `HATCHABOT_GATEWAY_PORT_BASE` was set near 65535
- **Check:** `HATCHABOT_GATEWAY_PORT_BASE` in `.env` is close to 65535, or many agents have been made; `sqlite3 <database> "SELECT name, gateway_port FROM agents WHERE gateway_port > 65535"` lists agents.
- **Cause:** each agent's gateway port counted up from the highest one ever given, with no check against the top of the range, so a port past 65535 was saved, and kept even after the base was set lower.
- **Fix:** upgrade: ports stay from the base to 65535. Past the top, the first port from the base that no agent holds is taken (a deleted agent's is free again), and when none is left the error says so. A port past 65535 saved before is given again at the agent's next provision or rebuild. Set the base lower if the range is full.
- **Fixed in:** `v2.178.0`
- **Code:** `src/store/store.ts` — `ensureGatewayAccess`

### After Rebuild all, a stopped agent started on its old image
- **Check:** you pressed **Rebuild all** (Bulk actions) while an agent was stopped or asleep. Its note said it would be rebuilt when it next starts, but after Start it still ran the old image (Overview → Runtime) or the old OpenClaw version.
- **Cause:** Rebuild all sent rebuilds to running agents only. Nothing marked the stopped ones, so their next start reused the old container.
- **Fix:** press **Rebuild** on that agent (this starts it). Since the fix, Rebuild all, and Bulk actions → **Rebuild** the same way, asks the server to rebuild each stopped or sleeping agent that a rebuild would change when it next starts. That is the same rule as Bulk actions' **Needs rebuild** chip: the server's "Needs a rebuild" (an image older than the fleet default among its reasons), a model waiting for a rebuild, or peer changes waiting for one. The agent stays down until then, and the result counts these agents separately. One already current is left as it is; one pinned to an image it does not run yet is rebuilt by its start in any case. Rebuild all's result also counts a request that failed as failed, naming the first three agents with their reasons; only an agent busy or already being changed is counted as skipped. Bulk actions → **Rebuild** skips an agent never built (no container yet) or moved to another machine, as Rebuild all does, instead of sending it a rebuild, and counts one turned away as busy or already changing as skipped, as Rebuild all does.
- **Fixed in:** `v2.178.0`
- **Code:** `web/index.html` — `rebuildAll`, `rebuildPlan`, `rebuildOrMark`, `rebuildChangesIt`, `faApply`, `reasonsSaid`; `src/api/routes.ts` — `stoppedWaits`

### Bulk actions said a model or class change was done, but the agent kept its old model
- **Check:** after Bulk actions → **Model** or **Class**, the result said "✓ N done", yet an agent's AI tab shows the old model, or it still answers on it.
- **Cause:** the result counted every saved change as done. The server's answer also says whether the running agent took the change. It may have refused it, left a model or memory limit pending, or need a rebuild for a source change. The page did not read that part.
- **Fix:** open the agent and choose the model again, or press **Rebuild**. Since the fix, the result counts what was applied, what waits for the next rebuild, and what was saved but not applied, naming every agent saved but not applied with its own reason; the failures' reasons, the first three, are above it. A class whose model applied while only the container's memory limits wait is counted as done, with a note that the limits come at the next rebuild.
- **Fixed in:** `v2.178.0`
- **Code:** `web/index.html` — `faApply`, `switchModel`

### After switching agents, one showed another's image pin, folders, variables, model menu or update form, or an error was never shown
- **Check:** you started a change on agent A (its image list loading, a folder, repo or variable added or removed, a class set, its app updated, a rename, a web search test) and opened agent B before it finished. Then B's image menu showed A's pin, or B's folder or variable list showed A's, or B's model menu was redrawn for A, or B's page asked for a value for A's app, or B's settings header showed A's new name, or B's Test web search or a folder's Test showed A's result, or B's Telegram tab offered people to add who were A's. Or, back on A while B's image list loaded, A's image menu showed B's pin, and Pin & rebuild pinned it to A. Or a change on A failed while B's Overview, or no page, was open, and nothing said so.
- **Cause:** the answer for A was drawn into whichever agent's page was open when it came back. With A's folders in B's list, removing an old-style folder from B sent A's folder list to B. An error was written under A's forms, which were out of sight.
- **Fix:** close the page and open the agent again. Check its folders (Knowledge), its variables (Advanced) and its image pin, and remove anything that is not its own; make again a change that may have failed. Since the fix, an answer for an agent whose forms are not on screen appears in a toast with that agent's name, and the page shown is left alone.
- **Fixed in:** `v2.178.0`
- **Code:** `web/index.html` — `forAgent`, `agentPrefix`, `populateImagePicker`, `addDataSource`, `removeDataSource`, `removeEnvVar`, `saveImagePin`, `assignClass`, `v2AppUpdate`, `renameAgent`, `testAgentSearch`, `checkDataSource`, `renderKnownPeople`, `addKnownPerson`

### After saving setup fields or adding a variable, folder or repo, the agent's page kept saying something was unsaved
- **Check:** the agent's page held back its redraw after Start or Stop, as if an edit were unsaved, until you closed it. Before that, either you pressed Save fields on its Personality tab and closed and reopened the page before the save finished; or you typed a variable (Advanced), a folder or a repo address (Knowledge), closed and reopened the page, and then pressed Add.
- **Cause:** the setup fields' save marked the list it sent as saved, while the page showed the list the reopening filled in. An Add emptied its box, while the page still took the text kept from before the reopening as the box's filled value. Either way the page counted an edit that was not there.
- **Fix:** close the agent's page and open it again. Since the fix, a save answered after the forms were filled again leaves the new fill as the saved list, as every other save in the page does, and an Add takes its emptied box as filled.
- **Fixed in:** `v2.178.0`
- **Code:** `web/index.html` — `saveSetupFields`, `prepareEdit`, `v2SheetSaving`, `addEnvVar`, `addDataSource`, `addGitSource`

### An image or memory setting chosen on Advanced was gone after looking at another tab
- **Check:** on an agent's Advanced tab you chose an image under Runtime and did not press Pin & rebuild, or chose a memory search engine, a memory cap or a swap allowance and did not press its Save. You opened another tab of the same agent and came back: the menu showed the saved value again, and leaving said nothing was unsaved.
- **Cause:** each time Advanced was drawn, the page filled these menus from the agent's saved values (and read the machine's images again).
- **Fix:** choose again and press Pin & rebuild, or Save. Since the fix, these menus are filled when the agent's forms are (opening its page), and again only for another agent, an image list that never loaded, or a value changed elsewhere (Bulk actions) while nothing else is chosen there. A choice stays, counted as unsaved, and the menu's other wording (what the agent inherits from its class or the fleet) is brought up to date around it. Saving the memory cap no longer resets a swap allowance chosen and not saved yet, or the reverse. While the image list loads (again, after a pin changed elsewhere, too), only the pin is offered and Pin & rebuild waits for it.
- **Fixed in:** `v2.178.0`
- **Code:** `web/index.html` — `v2EmbedPanes`, `populateImagePicker`, `prepareEdit`, `v2KeepsChoice`, `fillMemoryCapRow`, `fillSwapRow`

### Saving an edited scheduled task after looking at another tab added it a second time
- **Check:** on an agent's Schedule tab you pressed **Edit** on a task, looked at another tab of the same agent (Overview, say), came back and pressed the button under the form: the list then held the old task and a new one with your change.
- **Cause:** drawing the Schedule tab again ended the edit, but left the task's details in the form, so the button was **Add task** again and made a new task from them.
- **Fix:** delete the extra task (or the old one). Since the fix, an edit under way stays one when the same agent's Schedule tab is drawn again, with its **Save changes** button and its "Editing" note, until you save or cancel it; opening another agent's Schedule tab, or closing the agent's page, ends it. Save sends only what you changed from what Edit put in the form, so a change made to the task elsewhere since (by the agent, or on another page) is not put back.
- **Fixed in:** `v2.178.0`
- **Code:** `web/index.html` — `prepareCrons`, `cancelCronEdit`, `editCronJob`, `endCronEdit`, `cronFormOf`, `clearCronForm`, `addCronJob`

### A Group chats choice on the Telegram tab was gone before pressing Save
- **Check:** on an agent's Telegram tab you changed **Group chats** (or picked a group or server under it) and had not pressed its **Save** yet. The agent started or stopped meanwhile, and the tab was drawn again with the saved choice.
- **Cause:** the page took every menu on that tab that acts on its own as one that saves itself, so a change in Group chats or the room picker did not count as unsaved, and the redraw after a state change went ahead over it.
- **Fix:** choose again and press Save. Since the fix, only a menu whose change saves it (Who can reach it, Rich messages, and the group, class, sleep, files limit and browser menus) is left out; a change in Group chats or the room picker counts as unsaved until Save, and the tab waits for it.
- **Fixed in:** `v2.178.0`
- **Code:** `web/index.html` — `v2SheetCounts`, `data-saves`, `v2LoadChans`

### A value typed for one agent's environment variable, folder, repo or task was added to another
- **Check:** you typed a variable's name and value (or a folder path, a repo address, or a scheduled task) on one agent's page without pressing Add. Then you opened another agent and pressed Add there, and the value went to the second agent. Or a folder or repo was added to the second agent with write access, or as a public repo, chosen on the first agent's page. Or a setup field half-declared on the first agent (its key, label, type, default or options) was added to the second.
- **Cause:** those boxes, and the access and "public repo" choices beside them, kept what was set when the page switched agents.
- **Fix:** remove the variable, folder, repo, task or setup field from the second agent (Advanced → Environment, Knowledge → Folders, Schedule, or Personality → Setup fields), or set its access back to read-only there. Since the fix, those boxes are emptied, and the choices go back to read-only and not public, when another agent is opened.
- **Fixed in:** `v2.178.0`
- **Code:** `web/index.html` — `prepareEdit`, `prepareCrons`

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

### Memory search never comes up after a restart cut off its start: "The embedding service started but did not answer its health check"
- **Check:** `docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' hatchabot-embed-door` lists `bridge` but not `hatchabot-embed` (with your `HATCHABOT_PREFIX` in place of `hatchabot`).
- **Cause:** a start stopped between making the door and joining it to the server's network left a door with the right configuration that never joined. Later starts kept it as it was, and it could not reach the server.
- **Fix:** upgrade; a start joins a kept door to the server's network when it is not on it. On older versions, Stop and Start the service in Settings → Hosts, or `docker rm -f hatchabot-embed-door` and start it.
- **Fixed in:** `v2.171.0`
- **Code:** `src/providers/localDockerProvider.ts` — `ensureEmbedder`

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

### "Recover context after the switch" was ticked, but a stopped agent never recovered
- **Check:** the agent was stopped, asleep, archived or still being set up when it was moved to another source, or its rebuild could not start, and its chat never said it had recovered. The answer to the move counts it as not recovered.
- **Cause:** a move starts no rebuild for such an agent, and a recovery only runs chained to one. A stopped or sleeping agent takes the new source at its next start, which is a plain rebuild, and nothing is kept to run the recovery then.
- **Fix:** once the agent is up, its owner presses **Recover context** on its Personality tab, under Memory. It reads the old conversation on the new source. Nobody else can press it: after **Migrate all**, the machine's owner gets "Not found" on another account's agent, and the result counts those apart (`notRecoveredOthers`) so they can tell that owner. From `v2.173.0` the box, the result and the answer's `notRecovered` count all say so.
- **Fixed in:** `v2.173.0`
- **Code:** `src/api/routes.ts` — `switchAgentToSource`; `web/index.html` — `notRecoveredNote`, `moveAgentsApply`, `faApply`, `runMigrate`

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

### Memory search fails to start on this machine or a runner with "ENOENT" or "model checksum mismatch", while another one was starting too
- **Check:** the service log has `embedder.model_copied` or `embedder.model_download` from two services at about the same time (this machine's and a runner's, or two runners'), then a failed start naming `models/embeddinggemma-300m-qat-Q8_0.gguf`.
- **Cause:** every service on this Hatchabot uses one model file in the data folder. Two starting while it was missing each copied into that same file, and the second removed the first's copy while it was being written.
- **Fix:** upgrade; one copy of the model is made at a time, under a name of its own, and put in place once checked. A half-made copy left by a restart (`models/embeddinggemma-300m-qat-Q8_0.gguf.<number>.<hex>.part`) is removed at the next start, and a model file that fails its check is removed before it is fetched again. Start the service that failed again in Settings → Hosts.
- **Fixed in:** `v2.171.0`
- **Code:** `src/embedder/embedder.ts` — `ensureModel`, `clearStaleParts`

### A deleted or archived agent's memory search key still works on a runner
- **Check:** on the runner, the door's keys file (in its `-embed-keys` volume) still lists the agent's key hash, while `embed-keys.json` under the runner's `embed-hosts/<runner id>/` folder here no longer does.
- **Cause:** the agent was archived or deleted while the runner's memory search service was starting for the first time. The start copied the keys before the change and then took the newer file as already copied, so it was never copied again.
- **Fix:** upgrade; until then, any key change for that runner (a rebuild of one of its agents) or Restart of its service copies the current file.
- **Fixed in:** `v2.160.0`
- **Code:** `src/embedder/embedder.ts` — `syncKeys`, `start`

### Memory search answers "rate limited" while an agent indexes a lot of text
- **Check:** `docker logs <prefix>-embed-door` shows the agent's calls, and its memory search gets 429 "rate limited"; `HATCHABOT_EMBED_MB_PER_MIN` in `.env` is set low.
- **Cause:** the memory search door holds each agent to a call count (`HATCHABOT_EMBED_PER_MIN`, 600) and, from v2.170.0, to an amount of text a minute (`HATCHABOT_EMBED_MB_PER_MIN`, 8 MB), so one agent cannot keep the engine busy for every other. The default is far more text than the engine embeds in a minute; a lowered value can make a large re-index wait.
- **Fix:** raise or unset `HATCHABOT_EMBED_MB_PER_MIN` and restart Hatchabot (the door is replaced with the new limit).
- **Fixed in:** `v2.170.0`
- **Code:** `src/embedder/door.ts` — `doorScript`, `byteBucket`; `src/embedder/embedder.ts` — `mbPerMin`

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

### "A restore that has not finished still needs this snapshot" when deleting a snapshot
- **Check:** the agent has a held `restore-snapshot` operation (its Alerts line), and the snapshot is its target or the copy taken before it.
- **Cause:** those two are what **Finish** and **Revert** restore from. Before `v2.168.0` they could be deleted while the restore waited, after which neither choice worked and the agent could not be started.
- **Fix:** choose **Finish** or **Revert to the copy taken before**, then delete the snapshot.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/snapshots.ts` — `snapshotsInUse`; `src/api/routes.ts` — `snapshotsInUse`
## Console and web chat

### On a phone, the keyboard covers the box you are typing in (a panel, the web chat, the console)
- **Check:** the page is open on a phone; tapping a text box in a panel, the web chat or the console brings up the keyboard over it, and the box cannot be scrolled into sight.
- **Cause:** the keyboard covers the bottom of the screen without making the page shorter, and before v2.169.0 panels and dialogs kept their full height under it.
- **Fix:** upgrade: while the keyboard is up, panels, dialogs, the console and the web chat fit the part of the screen above it, and the box being typed in is scrolled into view. On an older version, turn the phone sideways or close the keyboard to read what is under it.
- **Fixed in:** `v2.169.0`
- **Code:** `web/index.html` — `fitVisualViewport`

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

### A web chat guest's page says "… was not sent: too many requests are waiting for an answer" (or "it has no id", "its id is too long", "got no answer: the agent took too long to answer")
- **Check:** the guest's browser has many requests open on one connection (a stuck tab, a script), or the agent is not answering (its status, `hatchabot doctor`). The message names `health` or `agents.list`. Before `v2.178.0` it could also say "its id is already in use", and name any request sent under an id still waiting.
- **Cause:** a guest's health and agent-list replies are rewritten to leave other people out, so each must be matched to its request. Before `v2.168.0` a request the proxy could not follow (past 1,000 waiting, with no id, or under an id still waiting) went through, and its reply reached the guest unrewritten. Before `v2.178.0` the match was by the guest's own id, so another reply under that id (a request sent under it, or the second answer to an `agent` request) could take the health reply's place, and the health reply then passed unrewritten. Now a health or agent-list request goes to the agent under an id the proxy makes, and its reply gets the guest's id back; a reply under such an id that nothing waits for is dropped, the reply keeps the agent's other fields but a refusal loses any payload it carried, and a reply in a form a guest's copy cannot be made from (or that Hatchabot fails to rewrite: `console.guest_scrub_failed` in the service log) is answered with an error. A message from the agent that is not a JSON object (not JSON, binary, an array or a bare value) is never passed on as it came: it is logged the same way and the guest's chat is closed with "Hatchabot could not read the agent's answer", as a request it may have answered would otherwise wait for ever. This is deliberate: OpenClaw sends only JSON objects in text frames, so anything else is refused rather than passed on unscrubbed. Such a request is refused (and not sent) past 1,000 waiting, with no id, or with an id longer than 256 characters; one not answered within 2 minutes is answered here ("took too long"), and a later answer to it is dropped. The 2 minutes are timed by a clock that only goes forward, so setting the machine's clock does not cut them short or stretch them. Other requests are not counted.
- **Fix:** reload the page; the console's requests always have short ids.
- **Fixed in:** `v2.168.0`; `v2.178.0` for a reply taken for another's under the same id
- **Code:** `src/api/consoleProxy.ts` — `spliceGuest`, `guestUntracked`, `guestError`, `MAX_GUEST_PENDING`, `MAX_GUEST_ID_LENGTH`, `GUEST_REPLY_WAIT_MS`, `GuestReplies`, `onScrubError`

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

### "Could not store the previous draft in browser storage. It remains available in this tab." on every pause in typing, in every agent's console
- **Check:** the line is OpenClaw's console's, and comes back on each pause in typing, in every agent's console you open, not only after attaching a file. In the browser's console (F12) each pause adds an IndexedDB error, and `sw.js?v=…` throws `Uncaught (in promise) QuotaExceededError: Quota exceeded.` DevTools → Application → Storage shows the site's usage at its quota, most of it Cache Storage (`openclaw-control-…`). chrome://settings/content/all shows the Hatchabot address holding gigabytes.
- **Cause:** every agent's console lives under its own path on one site address, so each one registered OpenClaw's service worker, which caches the console's files (55 MB a build) for offline use and keeps three builds — one copy per agent. A household of agents filled the browser's storage quota for the site, and the draft store (IndexedDB) shares that quota: its write fails after every change, 200 ms later, and the console says so. A private window, or site data blocked for the site, shows the same line for the same reason (no storage at all).
- **Fix:** upgrade: the proxy answers each console's `sw.js` with a stand-in worker that keeps nothing, deletes the `openclaw-control-*` caches and unregisters itself; a browser cleans up on its next visit to any console. Before the upgrade, or to clear it at once: in Chrome, chrome://settings/content/all → the Hatchabot address → Delete data (or DevTools → Application → Storage → Clear site data); it signs you out and the home screen forgets its console tabs, nothing else. A computer whose disk is nearly full gets a smaller quota from Chrome; make room.
- **Fixed in:** `v2.166.0`
- **Code:** `src/api/consoleWorkerStub.ts` — `CONSOLE_WORKER_STUB`; `src/api/routes.ts` — the `'/v1/agents/:id/ui/*'` route answers the worker itself

### The home screen's sort buttons run off the edge of a phone's screen
- **Check:** on a phone (390 px wide), under the View by pills, the sort buttons (Age, Name, Activity, My order; Cost under View by → Cost) run past the right edge and the last cannot be tapped.
- **Cause:** the sort buttons' box did not wrap below 620 px; the view pills beside it did.
- **Fix:** upgrade; they wrap. The click-through gate (`npm run test:ui`) opens the page a second time at a phone's width and checks every sort button is inside the screen.
- **Fixed in:** `v2.166.0`
- **Code:** `web/index.html` — `.v2binsort`; `scripts/ui-clickthrough.mjs` — `phoneSortButtonsReachable`

### On an iPhone, the View by pills under the header can't be seen, even at the top of the page
- **Check:** Hatchabot added to an iPhone's home screen (no browser bar): the first row of View by pills (Groups, Alerts, Machine …), or the Setup line when it shows, is hidden behind the header, and scrolling up does not bring it out. In Safari with its address bar it is fine.
- **Cause:** as a home-screen app the page draws under the iPhone's status bar (about 59 px), and the header was pinned that far down, so at the top of the page it sat over the first ~59 px below it.
- **Fix:** upgrade: the header is pinned at the very top with the status bar inside its own padding, so everything after it starts below it. The click-through gate's phone run sets a 59 px status bar and checks it.
- **Fixed in:** `v2.167.0`
- **Code:** `web/index.html` — `.v2top`, `--safe-top`; `scripts/ui-clickthrough.mjs` — `phoneChipsBelowTheStatusBar`

### On a phone, the header cuts off the account button, or never shows the version
- **Check:** on a phone about 400 to 460 px wide the round account button at the top right is cut off and the page scrolls sideways a little; on a narrower one (390 px) the header shows the egg but no version, so you cannot tell which build the phone runs.
- **Cause:** the header buttons were meant to shrink to 34 px on a phone, but a later rule set them back to 38 px, so six of them, the account button and the wordmark did not fit at 420 px. Below 400 px the wordmark was hidden to make room, and the version went with it.
- **Fix:** upgrade: the buttons shrink as meant, and below 440 px the wordmark gives way to the version, small and dim, under the egg. Until then the version is at the foot of the account menu.
- **Fixed in:** `v2.176.0`
- **Code:** `web/index.html` — `.v2top`, `.v2word`, `#v2AppVer`; `scripts/ui-clickthrough.mjs` — `phoneHeaderShowsTheVersion`

### On a phone, an agent's page covers the whole screen, and getting back home is awkward
- **Check:** on a phone, an agent's page (its settings sheet) fills the screen; the only way back is the ✕ at the top right.
- **Cause:** the sheet was drawn as on a desktop, the full height of the screen.
- **Fix:** upgrade: on a phone (640 px wide or less) the sheet stops short of the top, so a strip of the home screen shows above it and a tap there goes back, and ‹ Back sits at the sheet's top left, where every other panel has it, staying there while the tab scrolls. Esc still closes it; a desktop keeps its ✕.
- **Fixed in:** `v2.176.0`
- **Code:** `web/index.html` — `v2RenderSheetBar`, `.v2sback`, `.v2sheet`; `scripts/ui-clickthrough.mjs` — `phoneSheetHasAWayBack`

### On a phone, the Schedule tab runs off the right of the screen
- **Check:** on a phone, an agent's Schedule tab is wider than the screen: each task's words wrap one to a line, and **Delete**, the right of the New task form and **Add task** are cut off.
- **Cause:** a task's four buttons sat in one line beside its words, so the tab could not be narrower than about 400 px.
- **Fix:** upgrade: on a phone (640 px wide or less) the buttons go under the task's words, and the tab fits the screen.
- **Fixed in:** `v2.177.0`
- **Code:** `web/index.html` — `renderCrons`, `cronList`; `scripts/ui-clickthrough.mjs` — `phoneTasksFit`

### On a phone, a screen runs off the right edge, squeezes its words into a narrow column, or cuts a dropdown's choice short
- **Check:** on a phone (most Android phones are 360 px wide, an iPhone about 390), one of these: with an agent waiting in your Inbox, the round account button at the top right is cut off and every screen scrolls sideways a little; an agent's Data tab is wider than the screen; the Audit log's count and Refresh are off to the right; a member's name (Sharing), a share in the Inbox, a draft in Report a problem or a file in an archived agent's inspector runs a few words a line beside its buttons; a dropdown shows only the start of its choice ("No cap o" for Memory cap, "— model: leav" in Settings → Classes); a long image name in the Setup log is cut off; the tables in Usage (Context now, Saved by cheaper models) and in Settings → AI (Budgets, Model prices) show only their first columns; the cost chart's labels are too small to read (in Usage, or an AI source's Costs); a long file name in Files runs five lines; in Settings → Advanced a capability's name runs into its version.
- **Cause:** rows laid out for a desktop: buttons kept on the line beside their words, a dropdown kept beside its buttons and shrunk instead of given a line of its own, rows that did not wrap, wide tables scrolling sideways inside their box with nothing to say so, and a chart drawn 640 px wide and scaled down to the phone.
- **Fix:** upgrade: on a phone (640 px wide or less) the header's buttons narrow a little so all of them fit with Inbox showing (below 360 px, Resources moves to the account menu only); buttons go under the words they belong to; a dropdown with buttons beside it, a folder's path and the Audit log's filters wrap onto lines of their own, and the longest choices are shorter; long words break; each wide table becomes a card per row, every value named after its column; Files puts a name across the width with its size and age under it; a capability's name and version wrap rather than overlap; a file tapped in the inspector is brought into view when it starts out of sight; the cost chart is drawn at the width of its box, and again when that changes (the phone turned, or a Settings tab shown), its range buttons wrapping as a row. A computer draws the chart the same way, at its box's width up to 640 px: in a usual window its boxes are wider than that (an agent's Usage panel gives it about 750 px), so it looks as before, and in a window narrow enough to make a box narrower its words stay full size instead of shrinking. Nothing else on a desktop changed. Until then, turn the phone sideways or use a computer for those screens.
- **Fixed in:** `v2.178.0`
- **Code:** `web/index.html` — `phoneQuery`, `isPhone`, `.v2hubactions`, `#v2ResBtn`, `.pair`, `.phone-stack`, `.phone-wrap`, `.phone-flow`, `.reportdraft`, `#inspFileList`, `loadInspectFile`, `#setupLogBody`, `.cap-table`, `mpRow`, `spendChartWidth`, `spendChartSVG`, `spendChartFit`, `spendChartResized`, `spendChartsRefit`; `scripts/ui-clickthrough.mjs` — `phoneEveryScreenFits`, `phoneInspectorShowsTheFile`

### A file opened from Files on a phone has no way back
- **Check:** the app was opened from the phone's home screen (installed), a sound, video or PDF file was tapped in an agent's Files tab, and it filled the screen with no Back: the installed app has no browser bar.
- **Cause:** text and images opened in the tab since v2.165.0, with ← Back; sound, video and PDF still opened in a new browser tab.
- **Fix:** upgrade; they open in the tab, in the browser's own player or reader, with ← Back, Open in a tab and ⬇. Until then, close the file's tab from the phone's app switcher, or use the ⬇ next to the name instead.
- **Fixed in:** `v2.166.0`
- **Code:** `web/index.html` — `v2OpenFile`, `v2ShownHere`

### Opening a runner agent's console took the whole service down (the log ends with `spawn ssh ENOENT`)
- **Check:** the agent runs on a runner reached over `ssh://`; the moment its console was opened, the app stopped answering for everyone and the service restarted; `journalctl -u hatchabot` (or the service log) ends with `Error: spawn ssh ENOENT` from an unhandled `error` event. On the machine, `systemctl show hatchabot -p Environment` (or the launchd plist) gives the service a PATH without the folder `ssh` is in, or `ssh` is not installed.
- **Cause:** the console of a runner agent is reached through an SSH port forward the service opens itself. The child process that `ssh` spawn made had a listener for its exit but none for its error, so a spawn that failed (no `ssh` on the service's PATH, or one that cannot run) raised an unhandled event and ended the process.
- **Fix:** upgrade: a failed spawn is "the console is unavailable" for that agent and nothing more. Then give the service a PATH with `ssh` in it (or install openssh-client); the runner's docker connection needs it too.
- **Fixed in:** `v2.166.0`
- **Code:** `src/providers/localDockerProvider.ts` — `gatewayEndpoint`, the tunnel's `child.once('error'`

### A web-chat invite link let someone into a different agent than the one it was made for
- **Check:** you pressed Make link in one agent's Invite, closed it and opened another agent's Invite before the link appeared; the link shown under the second agent's name opens the first agent's web chat.
- **Cause:** the first agent's link, made late, was put into the invite open at that moment, which also hid that agent's own Make link.
- **Fix:** in the first agent's Sharing → Access, remove whoever came in by mistake, then make a new link from the right agent. Since v2.168.0 a link is shown only in the invite it was made for.
- **Fixed in:** `v2.168.0`
- **Code:** `web/index.html` — `makeWebChatInvite`, `invite`

### A quiet scheduled task's result never puts the unread mark on an agent that has a Telegram bot
- **Check:** the agent has a bot (Telegram, Discord or Slack); the task is quiet (`delivery.mode` is `none` in `openclaw cron list --json`); it ran after you last opened the console, and its result is in the console, but the agent's icon has no unread mark.
- **Cause:** every scheduled run of an agent with a bot was taken as delivered to the bot, so a quiet task's result, which goes nowhere but the console, was never counted.
- **Fix:** upgrade: the runs of the agent's quiet tasks count toward its unread mark; a task that announces to the chat still does not, since the chat shows its own, and neither does OpenClaw's own upkeep (a declared job such as the weekly skill review). The agent's tasks are read only after one of them has run since the last read, or ten minutes on (one quick read of OpenClaw's task store, 2026.9 and later).
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/unread.ts` — `consoleActivity`, `quietTaskIds`, `cronRunsSignature`, `markQuietTasks`; `src/api/routes.ts` — `readSessions`

### Web chat: a message stayed as sent with an error under it, and its text was gone from the box
- **Check:** the error says the agent is busy or not running, or "messages this hour". Close and reopen the chat: the message is not in the conversation.
- **Cause:** the box was emptied and the message shown before the request. Only the needs-a-rebuild refusal put it back, though every refusal happens before the agent sees the message.
- **Fix:** upgrade: a refused message goes back in its agent's box and leaves the log, so it can be sent again, ahead of anything typed since. That covers a session that ended, a second factor not given, and an agent that could not be woken. "No answer within…", "The turn did not complete" and a lost connection leave it as sent, because it may have got through; reopen the chat to see. If it is not in the conversation it comes back to the box with a note, and is not sent until you send it. On an older release, copy it from the log before you close the chat.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `webChatSend`, `webChatGiveBack`, `webChatOfferUnsure`; `src/api/webChat.ts`

### Web chat: the box holds what someone else typed, or their chat is still open, after a sign-in
- **Check:** one person's session ended on a shared browser (the sign-in screen appeared by itself), and the next person signed in without the page being reloaded. Their box for that agent held the first person's draft, or the first person's chat and log stayed open, where Enter would send the draft as the new person.
- **Cause:** Sign out reloads the page, but a session that lapses and a sign-in do not, and nothing cleared what the page held for the person.
- **Fix:** upgrade: when a session ends the chat closes and its text leaves the screen. If the same account signs back in, its drafts are back in their boxes. If another account does, they are dropped, with other dialogs, unsaved source edits and report text. On an older release, reload the page before handing it over.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `showLogin`, `pageSessionEnded`, `pagePersonIs`, `pageSignedIn`, `webChatPutAway`, `webChatForget`

### Web chat: text from one agent's chat is in another agent's box, or a message disappeared after switching
- **Check:** you sent a message and switched agent, or closed the chat, before it was answered; or a message was refused and you then opened another agent's chat. Enter there would send it to that agent.
- **Cause:** one text box served every agent, and a refusal after you moved on only showed a toast.
- **Fix:** upgrade: each agent keeps its own draft while the page is open. A refused message waits in its own agent's box, and the toast says so. On an older release, check the name at the top of the chat before pressing Enter.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `webChatShowDraft`, `webChatGiveBack`, `openWebChatPanel`

### Web chat: a refusal removed a message that had been delivered
- **Check:** you closed and reopened a chat while a message was waiting, it was then refused ("messages this hour", say), and an earlier message of yours left the log until the chat was opened again.
- **Cause:** the refusal removed the last of your messages on screen. After a reopen the waiting one is not there, so that was a delivered one. Only the view changed, not the conversation.
- **Fix:** upgrade: a refusal removes only that send's own bubble. On an older release, reopen the chat.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `webChatSend`

### Web chat put a message that had arrived back in the box, saying it may not have been delivered
- **Check:** a message you sent got no answer in time (or a 502). When you reopened the chat, it came back in the box with "may not have been delivered", although the conversation shows it. It happens when the same words (an "ok", a "thanks") appear earlier in a long conversation.
- **Cause:** the page counted the same words across the whole log. The log holds only the last 100 messages, so when an older copy dropped off the top the count stayed the same, and the new message looked missing.
- **Fix:** clear the box rather than send it again. Since the fix, the page counts only the messages after the conversation it last read, by their times, against every message sent since that read, answered or not. A message sent before the conversation has loaded (Send does not wait for it), or after a read that failed, is counted only against copies the conversation times after it was sent, in the server's time when the page has had an answer saying what that is (so a browser clock that is off does not matter); with no times, it comes back. The same words sent again after the conversation loads are counted with it, by time, so one answered before the load is not counted twice. Its bubble and answer stay when the conversation loads. A message the log gives no time is counted by its words, against those that had no time when the page read the log. One still waiting for its answer when the chat is opened again is counted, with those sent after the same read, at the next open after its answer. An answered message with nothing in doubt beside it is not kept: the next message of the same words counts it from its bubble. When the conversation cannot be read (rebuilt, moved or busy), a message that may not have arrived waits for the next open that can read it.
- **Fixed in:** `v2.178.0`
- **Code:** `web/index.html` — `webChatSend`, `webChatOfferUnsure`, `webChatAnswered`, `webChatCanSend`, `openWebChatPanel`, `serverAheadMs`; `src/orchestrator/webChat.ts`

### A web chat guest's console disconnects with "took nothing it was sent for 60 s", "stopped sending", "took over 10 minutes to send one message", "too much waiting to be sent", "too many answers waiting to be sent", "message in too many frames", "a control frame over 125 bytes", "a control frame in fragments", "your open chats hold too much at once", "opened in another tab", "you have 8 chats open; close one", "Hatchabot could not prepare this chat" or "Hatchabot could not read the agent's answer", or Hatchabot's memory grows while a guest's chat is open
- **Check:** the guest's browser console shows the WebSocket closed with one of those reasons. A reason that starts `gateway:` (code 1011) is the agent's side: its container was busy, stopped or unreachable (`hatchabot doctor`, the agent's status); one that starts `refused:` (code 1008) is the browser's: it stopped reading or sending, or sent what no console sends. "opened in another tab" (code 1001) is not a fault: the guest opened one chat more than they may have, and their least recently used one was closed to make room (`console.guest_oldest_closed` in the service log). A new chat that does not open, or closes with "you have 8 chats open; close one", met the same limit with none of the 8 unused for 2 minutes, or with one already closed to make room in the last 10 and none unused for 10, or (rarely, code 1008 just after it opens) the one set aside for it was used again while it connected (`console.guest_too_many`). "Hatchabot could not prepare this chat" (code 1011) is Hatchabot's own failure to make a guest's copy of the agent's first reply; "Hatchabot could not read the agent's answer" (code 1011) is the agent sending something that is not a JSON object (both `console.guest_scrub_failed` in the service log, with what was sent and its size). "a control frame over 125 bytes" or "a control frame in fragments" (code 1002) is a ping, pong or close that RFC 6455 forbids, from the side the reason names; it is not passed on. A chat closed while a message to the browser was part sent ends with no close frame there (code 1006, no reason): the rest of that message could not be read. Before `v2.178.0`: the Hatchabot service's memory climbed while a guest's tab sat open on a slow or stalled connection.
- **Cause:** a guest's console connection goes through Hatchabot's filter, which used to write to a side that was not reading while it kept reading the other, so the unsent bytes piled up in Hatchabot's memory without limit; and a message's size was capped but not the number of frames it came in, so a client could leave any number of empty ones waiting. Now the agent is not read while more than 64 KB waits for the browser. The browser is still read then: its pings and pongs reach the agent at once, and so does a stop (`chat.abort`, `sessions.abort`) unless requests are kept ahead of it, while its other requests are kept and sent, in order, once it catches up, so a guest who is not taking replies sends nothing new to the agent meanwhile; once 64 KB of them are kept, the browser is not read until it catches up. Its close goes at once, what is kept is dropped, and nothing it sends after its close is passed on. The browser is not read while more than 64 KB waits for the agent either. The refusals waiting for the browser may not pass 256 KB. What waits for a side is handed over 16 KB at a time; a side that takes nothing for 60 seconds closes the connection, so does more than the largest message and 4 MB waiting for one side. When the agent closes the chat, its close is answered at once, and what waits for the browser still goes first, then the agent's own close code and reason; the browser has 30 seconds to take it, after which the connection is ended; meanwhile it is read again, if it was held back, so its leaving is seen, and what it sends is dropped. Until the browser's connection ends, the chat still counts toward the guest's limits and is closed like any other (access removed, sign-out, the idle limit, one chat more), and what it holds counts down as the browser takes it. When the browser closes it, what waits for the browser is dropped (but for the rest of a message part sent), its close goes to the agent once (if the chat ends before the agent has taken it, it is written then), and the agent's answer comes back to it next. A message may come in at most 1,024 frames, and must keep coming: a side that sends part of one and then none of it for 60 seconds while it is read (counted from when it is read again, if Hatchabot held it back; pings and pongs do not count) closes the connection ("stopped sending"), and so does one not whole within 10 minutes of its first bytes, however they come ("took over 10 minutes to send one message": a 32 MB attachment needs about 55 KB/s). Only time the side is read counts toward those 10 minutes: an agent held back while a phone slowly downloads a long history does not use them up. So a message never finished is not held for ever. A frame's header is read once, however many pieces it comes in, and its bytes are copied once, when it is whole; a message in several frames is held as it came and unmasked once, when it is whole. Each piece Hatchabot holds counts for 64 bytes more than its size, so many tiny ones count as more. A guest's open chats together may hold at most 160 MB (messages begun and not finished, and what waits to be sent): more than one chat can hold on its own, so the chat whose bytes push past it is closed ("your open chats hold too much at once") only when others hold some too. A guest may have 8 chats open at once (all agents together). Chats still connecting count too. One more is let in only if one of theirs that is connected has gone unused for 2 minutes (timed by a clock that only goes forward, so a wall clock set forward makes none idle) and is not being answered (a reply or the agent's work for a run that chat started streaming to it in the last 2 minutes, or a message sent from it, by the chat or the `agent` request, whose run has not ended: the agent saying it started or accepted the run is not its end, the run's last reply or result is; for up to 10 minutes from the last of these; another chat of theirs on the same conversation does not keep it from being idle): as it is let in, the one they used least recently is set aside for it and counted as gone, so two opened at once cannot both take the same place, and once it connects, that one is closed ("opened in another tab"). If it fails to connect, or the guest leaves first, nothing is closed. One unused for 10 minutes or more (a tab whose phone slept without closing its connection) can always be closed this way, so those never lock them out; one unused for less, only once in 10 minutes, so idle tabs that reconnect cannot close each other in turn. Otherwise one more is refused at the door ("you have 8 chats open; close one"), so tabs in use cannot close each other either. At most 8 of a guest's chats may be connecting at once (one more is not let in: `console.guest_too_many_connecting`); one the agent has not accepted within 30 seconds is closed (`console.guest_connect_timeout` in the service log) and stops counting. A reply the chat waits for that Hatchabot fails to make a guest's copy of (the agent's first reply) closes it ("Hatchabot could not prepare this chat"), and so does anything from the agent that is not a JSON object ("Hatchabot could not read the agent's answer"): passed on as it came, either could show other people's sessions. At the public address, a guest's console stays active (the idle limit) only by what the guest sends: each message, each piece of an upload (a message of 16 KB or more still arriving; once whole, one that does not count, refused or a poll, puts back what its pieces marked, but not a message of theirs the agent took meanwhile), and a message waiting for the agent each time the agent takes some of it (any frame of it); not pings or pongs, the console's own `health` and `agents.list` polls, requests refused here, or the agent streaming to a slow browser.
- **Fix:** reload the page. "opened in another tab" needs nothing: use the newer tab, and close tabs the guest no longer uses. For "you have 8 chats open; close one", close a chat tab first. For "your open chats hold too much at once", close the guest's other chat tabs first. "Hatchabot could not prepare this chat" or "Hatchabot could not read the agent's answer" that keeps happening is worth a report, with the `console.guest_scrub_failed` line. For a `gateway:` reason, check that the agent is running and not overloaded, then reload. A browser on a slow connection is not closed while it keeps taking what it is sent. A `refused:` close that keeps happening with a normal browser is worth a report; one from something that is not a normal browser can be ended by removing that member's web chat on the agent's Sharing tab.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/consoleProxy.ts` — `spliceGuest`, `Outbox`, `BEHIND`, `GUEST_KEEP_LIMIT`, `GUEST_CANCELS`, `GUEST_QUEUE_SLACK`, `GUEST_REFUSAL_BUDGET`, `GUEST_STALL_MS`, `MESSAGE_DEADLINE_MS`, `GUEST_HELD_LIMIT`, `GUEST_DRAIN_MS`, `ProtocolFault`, `GuestActivity`, `MAX_MESSAGE_FRAMES`, `CONSOLE_POLLS`, `MAX_GUEST_CONSOLES`, `GUEST_IDLE_TO_CLOSE_MS`, `GUEST_ROOM_EVERY_MS`, `GUEST_CONNECT_TIMEOUT_MS`, `FrameReader`, `WsFrame`; `src/api/routes.ts` — `onActive`, `console.guest_oldest_closed`, `console.guest_too_many`, `console.guest_too_many_connecting`, `console.guest_connect_timeout`; `src/orchestrator/consoleAccess.ts` — `trackGuest`, `promiseRoom`, `RoomPromise`, `addGuestHeld`

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

### A tcp:// runner is refused ("reached over TLS only"), or stopped answering after an upgrade
- **Check:** the runner's address starts `tcp://`; on the Hatchabot machine, `ls "${DOCKER_CERT_PATH:-$HOME/.docker}"` lacks `ca.pem`, `cert.pem` or `key.pem`; `docker -H tcp://<runner>:2376 --tlsverify version` fails.
- **Cause:** a `tcp://` runner is spoken to over verified TLS only. Plain `tcp://` carried every call, the agent's bot token among them, unencrypted to a daemon that checks nobody.
- **Fix:** use `ssh://user@host` (remove the runner and add it again), or set up TLS on that Docker daemon and put its client certificates in `~/.docker` (or `DOCKER_CERT_PATH` in the service's environment). See docs/runner-setup.md.
- **Fixed in:** `v2.169.0`
- **Code:** `src/providers/runnerEndpoint.ts` — `dockerConnArgs`, `tcpTlsProblem`

### Moving an agent to a runner fails with "pull access denied for hatchabot-runtime"
- **Check:** the agent is pinned to an image the runner does not have.
- **Cause:** before v2.33.3 the move found out only after stopping the agent.
- **Fix:** upgrade: the move checks first and offers to move on the runner's default image (its extra packages are then missing). Or install the image on the runner.
- **Fixed in:** `v2.33.3`
- **Code:** `src/api/routes.ts` — `dropPin`

### After a move to another machine failed and was rolled back, the card says the agent runs a new AI source it does not have
- **Check:** the agent's source was changed before the move (a rebuild was due), the move was rolled back, and the card no longer offers the rebuild; its usage is counted under the new source.
- **Cause:** the target's build recorded its configuration as applied before the target had started; rolling back put the agent back on its source machine, whose container still runs the old source, but not its record.
- **Fix:** upgrade: an undone move puts back the record of what the source runs (its AI source, model and memory search engine). For an agent already affected, rebuild it.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/moveHost.ts` — `putBack`, `appliedBefore`; `src/store/store.ts` — `restoreAgentApplied`

### A runner was removed while a move from it was held, and "Put it back" then fails ("did not start there")
- **Check:** the agent's move is held under Alerts, and the machine it came from is no longer under Settings → Hosts.
- **Cause:** a runner could be removed as soon as no agent's record named it, but a held move still needs the machine it came from: Put back starts the agent's copy there.
- **Fix:** upgrade: removing a machine is refused while a move to or from it is not over. If it is already gone, choose "Try again" once the machine it was going to answers: that finishes the move there. The copy left on the removed machine is then removed by hand (`docker rm -f` and `docker volume rm` the agent's container and volume there).
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/routes.ts` — `'/v1/hosts/:id'`; `src/orchestrator/moveHost.ts` — `recoverMoveHost`

### A pinned agent moved "on the runner's default image" lost its image after a restart undid the move
- **Check:** the move was made with "use the runner's default image" (`--drop-pin`), Hatchabot restarted during it, the move shows "interrupted by a restart and undone", and the agent's Runtime tab no longer names its image.
- **Cause:** the pin was dropped before the move was recorded, so the rollback after the restart put the agent back on its machine without it; its next rebuild used the default image and lost the extra packages.
- **Fix:** upgrade: the pin is dropped by the move itself and put back whenever the move is undone. For an agent already affected, pin it to its image again (Runtime tab), then rebuild.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/moveHost.ts` — `keepPin`, `droppedImage`; `src/api/routes.ts` — `'/v1/agents/:id/move-host'`

### An agent moved while stopped is missing tools after its first start on the new machine
- **Check:** the agent was STOPPED when it was moved; it keeps an `~/.openclaw/on-rebuild.sh`, and its Setup log has no `rebuild_hook.ran` (or `.failed`) after the move.
- **Cause:** tools installed outside the agent's home come from the image and are put back by its rebuild hook, which a move ran only for an agent that was running.
- **Fix:** upgrade: the hook is owed to the new container and runs at its next start (or wake). For an agent already affected, rebuild it.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/moveHost.ts` — `completeOnTarget`; `src/orchestrator/provision.ts` — `runOwedRebuildHook`; `src/store/store.ts` — `setRebuildHookDue`

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

### A runner was removed without a warning, but its `<prefix>-embed-keys` volume is back on it
- **Check:** `docker volume ls` on that machine shows `<prefix>-embed-keys` (and no `<prefix>-embedder` container) after the removal said nothing was left there; the service log may show `embedder.keys_push_failed` for that host just after.
- **Cause:** a copy of the memory search keys to the runner that was under way, or waiting, when the runner was removed went on after the removal, and made the key volume again with the retired engine key in it.
- **Fix:** upgrade; removal drops a waiting copy, makes no new one while it runs, and lets the one under way finish before it removes the volumes. On older versions, `docker volume rm <prefix>-embed-keys` on that machine.
- **Fixed in:** `v2.171.0`
- **Code:** `src/embedder/embedder.ts` — `remove`, `syncKeys`, `#pushKeys`

### On a runner with rootless Docker, its memory search will not start ("embed door failed … cannot assign requested address"), or its agents cannot reach it
- **Check:** `docker info --format '{{.SecurityOptions}}'` on the runner includes `name=rootless`.
- **Cause:** the rootless rules (a door on loopback, agents reaching the machine at the rootless network's host address) applied only to this machine's daemon. A rootless runner's door was published on its bridge address, which exists only inside the rootless namespace, and `host.docker.internal` in its agents pointed into that namespace too.
- **Fix:** upgrade; a runner's daemon is asked whether it is rootless, and the same rules apply there. Then Start the runner's memory search in Settings → Hosts and rebuild its agents, so they get the new host address. `HATCHABOT_DOCKER_ROOTLESS` speaks for this machine only. The agents reach the door through the rootless network's host address only when the runner's rootless Docker lets containers reach its loopback, which is off by default: set `DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false` for its Docker service, as for this machine (docs/shared-host.md). Without it the door starts and reports healthy, but the agents' memory searches fail.
- **Fixed in:** `v2.171.0`
- **Code:** `src/providers/localDockerProvider.ts` — `rootless`, `hostGatewayAddress`, `hostAliasTarget`, `hostAddressForAgents`

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

### An agent made while its runner was being removed points at a machine Hatchabot no longer knows
- **Check:** the agent's tile names no machine or says it cannot be reached, Start fails with "No such host", and Settings → Hosts no longer lists the runner it was made on; it was made (or imported, or moved there) while that runner was being removed.
- **Cause:** removing a runner checked it was empty, then waited on the runner (does it answer, what does it run) before deleting it; an agent placed there during that wait was left on a host that was gone.
- **Fix:** delete the stranded agent and make it again on a machine that exists. Since the fix a runner being removed takes no new agent ("That host is being removed."), a move to it checks it is still there before it starts, and the removal looks again before it touches the runner and just before it deletes it, and stops if an agent arrived.
- **Fixed in:** `v2.171.0`
- **Code:** `src/api/routes.ts` — the `'/v1/hosts/:id'` delete route, `removingHosts`; `src/orchestrator/transfer.ts` — `importAgent`; `src/orchestrator/moveHost.ts` — `moveAgentToHost`
### A second runner on the same machine, at the default port, is reached on the first one's port
- **Check:** `ssh -G <runner-host> | grep -E '^(port|user) '` on the Hatchabot machine shows the port (or user) of an address added earlier, and `~/.ssh/config` has a `Port` or `User` line under `# agentclaw-runner: <host>`.
- **Cause:** the managed block is one per hostname, and it kept the port and user of the first address added for that machine; a later address with no port (or no user) inherited them.
- **Fix:** upgrade, delete the `Port` and `User` lines under that marked block (a block already there is never rewritten), then **Check** the runner. New blocks carry neither: the address gives them on every call.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/runnerSetup.ts` — `ensureSshConfigBlock`, `writeSshConfigBlock`

### A runner fails with "Too many authentication failures" or a host-key prompt though the managed block says `IdentitiesOnly yes`
- **Check:** `ssh -G <runner-host> | grep -E '^(identitiesonly|stricthostkeychecking) '` prints `no` or `ask`; in `~/.ssh/config` a `Host *` (or another block matching the runner) comes before `# agentclaw-runner: <host>`.
- **Cause:** ssh keeps the first value it reads for each option, and the managed block was added at the end of the file, below the person's own defaults.
- **Fix:** by hand (a block already there is never rewritten, and a runner with agents on it cannot be removed and added again): cut the marked block (from `# agentclaw-runner: <host>` to the next blank line) and paste it at the top of `~/.ssh/config`, then add a line `Host *` right after it, so what follows still applies to every host. Drop its `Port` and `User` lines while there (see the entry above), then **Check** the runner. After the upgrade, a runner added new gets its block at the top this way.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/runnerSetup.ts` — `writeSshConfigBlock`

### "docker: command not found" over ssh to a runner whose ~/.bashrc stops non-interactive shells
- **Check:** on the runner, `grep -n 'agentclaw: docker on PATH' ~/.bashrc` shows the line below a `case $- in *i*) ;; *) return;; esac` (or `[ -z "$PS1" ] && return`); `ssh <user>@<runner> 'echo $PATH'` lacks `/usr/local/bin`.
- **Cause:** the setup snippet appended its PATH line to the end of `~/.bashrc`, below the guard that returns early for the non-interactive shell ssh runs commands in.
- **Fix:** on the runner, move the two `agentclaw: docker on PATH` lines to the top of `~/.bashrc`, or delete them and paste the setup snippet from an upgraded Hatchabot, which puts them first.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/runnerSetup.ts` — `runnerSetupSnippet`

### Install image says it failed ("exit ?/0"), but the runner has the image
- **Check:** the error is `exit ?/0`; **Check** on the runner then finds the runtime image.
- **Cause:** the runner finished loading the image a moment before this machine's `docker save` closed, and the copy was judged (and the sender killed) without waiting for its exit.
- **Fix:** upgrade; until then, **Check** the runner: the image is there and usable.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/runnerSetup.ts` — `installRuntimeImage`

### With HATCHABOT_SSH_DIR set, a new runner never connects
- **Check:** `HATCHABOT_SSH_DIR` in `.env` names a folder other than `~/.ssh`; that folder holds `agentclaw_runner` and a `config` with the runner's block, and `~/.ssh/config` does not include it.
- **Cause:** the key and the block are written there, but ssh (for Docker and for the console's tunnel) reads only `~/.ssh/config`.
- **Fix:** unset `HATCHABOT_SSH_DIR` (it is a setting for tests) and set the runner up again, or put `Include <that folder>/config` at the top of `~/.ssh/config`. Then **Check** the runner.
- **Fixed in:** `v2.171.0` (listed as a setting for tests)
- **Code:** `src/orchestrator/runnerSetup.ts` — `sshDir`; `src/config/envCatalog.ts` — `HATCHABOT_SSH_DIR`

### A removed runner still has a stopped `hatchabot-io-…` container, holding an agent's archive
- **Check:** on the machine that was a runner, `docker ps -a --filter label=hatchabot.oneshot` lists an exited `…-io-…` container. It was stopped by Docker (a `docker stop`, a daemon restart, the machine powering off) during a restore or a move, and the runner was removed from Hatchabot before the next sweep.
- **Cause:** such a one-shot keeps its copy of the agent's archive (`/tmp/s.tgz`). The sweep that removes finished one-shots every 10 minutes visits only the runners Hatchabot knows, and removing a runner did not sweep it first.
- **Fix:** `docker rm -f` it on that machine. Since the fix, removing a runner that answers removes its finished one-shots, and says so when it cannot.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `'/v1/hosts/:id'` (DELETE); `src/providers/localDockerProvider.ts` — `sweepOneShots`

### Adding two runners at once on a new install: one setup never finishes
- **Check:** this machine had no runner key yet (`~/.ssh/agentclaw_runner` absent), and two runners were added at the same moment (two tabs, or the Hatchabot agent and the page); one of them stays on its first step, and `ps` shows an `ssh-keygen` for `agentclaw_runner` waiting.
- **Cause:** each setup saw no key and ran `ssh-keygen` on the same file. The second one found the first's key and asked whether to overwrite it, with nobody to answer.
- **Fix:** upgrade; on an older version restart the service, then add the runner again (the key the first made is used). Since the fix one setup makes the key and the other waits for it; the key is made under another name and moved into place, and `ssh-keygen` is stopped after a minute. Two Hatchabot processes making it at once (a service and `hatchabot` on the command line) keep the first key put in place; the one that finds the other's key there reads the public half out of that private key, and writes `agentclaw_runner.pub` again when it does not match. Otherwise `agentclaw_runner.pub` is used as it is, and read out of the private key only when it is missing (if `ssh-keygen -y` fails then with the file there, the file is used and the journal says `runner_key.public_unchecked`). The key is written to the disk before it is put in place, so the one there is never cut short; on a filesystem with no hard links it is renamed into place under `agentclaw_runner.lock`, only if no key is there (a lock left over 10 seconds by a stopped process is taken over; one taken by mistake is put back only where no other lock is, and a setup whose lock was taken starts over rather than put its key beside another's). A key there that does not read, with no `agentclaw_runner.pub` beside it, fails with "the runner key … cannot be read … remove … and add the runner again": do that, and give runners set up with the old key the new public key.
- **Fixed in:** `v2.178.0`
- **Code:** `src/orchestrator/runnerSetup.ts` — `ensureRunnerKey`, `makeRunnerKey`, `renameIfAbsent`, `publicHalf`, `readPublic`

### A move or a restore resumed after a restart failed on a runner, and its one-shot was gone
- **Check:** the service had just restarted, the operation was on a runner, and that runner's clock is behind this machine's (`date -u` on both). The failure names a one-shot (`hatchabot-io-…`, `hatchabot-vx-…`) that no longer exists.
- **Cause:** at start the app removes leftover one-shots that never ran, and told them apart by when they were made: before this process started. That compared the runner's clock with this machine's, so on a runner running behind, one the restarted process had just made looked older and was removed. On a runner running ahead, a real leftover was kept.
- **Fix:** upgrade: each one-shot carries a label naming the process that made it. Only those another process made over 5 minutes ago are removed, timed by the Docker daemon's own clock, so another process (a CLI command) can be making one meanwhile. Every one stays, whatever their state (made, finished or dead) and whichever process made it, until 5 minutes after it finished (or, never run, was made): a call may still be reading what one left, however long it ran. This runs at start and every 10 minutes, so a crashed process's are gone within minutes. A nightly backup's, while that run is going, is left alone. On an older release, keep the runners' clocks right (NTP), then run the operation again.
- **Fixed in:** `v2.178.0`
- **Code:** `src/providers/localDockerProvider.ts` — `sweepOneShots`, `ONESHOT_PROCESS_LABEL`, `ONESHOT_STALE_MS`, `#idleLongAgo`; `src/index.ts` — `sweepOneShots`

## Backups and restore

### `hatchabot backup --out <folder>` stopped the agent and saved nothing ("EISDIR")
- **Check:** the `--out` given was an existing folder (or a path this account cannot write); the agent is STOPPED and no `.hatchabot` file was made.
- **Cause:** only the folder around the destination was checked before the backup; the backup stops the agent to export it, and the destination itself failed only afterwards.
- **Fix:** upgrade; the destination is made ready before the server is asked, so a folder, a missing folder, one you cannot write into, or another account's file in a shared folder such as `/tmp` (one you could not replace) is refused while nothing has been stopped. Give a file name (`--out ~/backups/<agent>.hatchabot`). On an older version, start the agent again (`hatchabot start <agent>`) and rerun with a file name.
- **Fixed in:** `v2.171.0`
- **Code:** `src/cli.ts` — `saveTarget`, `renameRefused`, `'backup'`

### `hatchabot doctor`: "No backup set in … yet", "Last backup set is N days old", or "… is incomplete"
- **Check:** `journalctl --user -u hatchabot-backup -n 30` (macOS: the backup job's log); the set's own record names failed volumes.
- **Cause:** the nightly job did not run or failed. A known case: a backup unit without `EnvironmentFile=` looks for the database in the wrong place after the data directory moved.
- **Fix:** re-render the units with `./scripts/install-service.sh`, run `systemctl --user start hatchabot-backup` once, and check a new set appears. `scripts/restore-drill.sh` proves a set restores.
- **Fixed in:** —
- **Code:** `src/doctor.ts` — `readSetStatus`; `deploy/hatchabot-backup.service` — `EnvironmentFile`

### `hatchabot doctor` says "Last backup set is 3 days old" in the evening, while the app calls the same set 2 days old
- **Check:** the machine's time zone is west of UTC (the Americas), it is evening, and the set doctor names is the one the app shows as the newest; the next morning doctor and the app agree.
- **Cause:** doctor counted the set's date as midnight UTC and rounded down, so from late afternoon or evening local time it read a day older than the app, which counts by the calendar. It warns past 2 days, so it warned a day early.
- **Fix:** upgrade: doctor now counts the days the way the app does. Before that, the app's figure is the right one.
- **Fixed in:** `v2.174.0`
- **Code:** `src/doctor.ts` — `backupFacts`; `src/orchestrator/recoveryReadiness.ts` — `setAgeDays`

### A backup run by hand says complete, but the set holds an old registry and says the agents' volumes are used by no agent
- **Check:** `.env` sets `HATCHABOT_DB` (or `HATCHABOT_BACKUP_DIR`, `HATCHABOT_PREFIX`); the set `./scripts/backup-volumes.sh` made lists your agents' volumes under `orphans` in its `backup-status.json`, or the run stops with "No database at data/hatchabot.sqlite".
- **Cause:** before v2.168.0 a run started from a shell did not read `.env` (only the nightly timer had it, through its unit's `EnvironmentFile`), so it backed up the default database and namespace, not the ones the service uses.
- **Fix:** upgrade. Before that, start the timer's job instead: `systemctl --user start hatchabot-backup`. A value set on the command line (`HATCHABOT_BACKUP_DIR=… ./scripts/backup-volumes.sh`) still wins over `.env`.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/backup-volumes.sh` — `parseEnv`

### The backup alert says an agent is "not in it", naming a runner
- **Check:** the backup set's record lists it under `skipped`.
- **Cause:** before v2.133.0 only this machine's volumes were backed up. Now a runner that does not answer is skipped and named.
- **Fix:** upgrade; keep the runner awake at backup time (03:30) or accept the skip.
- **Fixed in:** `v2.133.0`
- **Code:** `src/orchestrator/backups.ts` — `agentsMissingFromSet`; `scripts/backup-volumes.sh` — `skipped_list`

### Every nightly backup is incomplete: an agent's volume is "missing" and an `agentclaw-vol-…` volume is an "orphan"
- **Check:** the set's `backup-status.json` lists `<12 hex characters>-vol` under `missing` and `agentclaw-vol-<the same characters>` under `orphans`, and `docker ps -a` shows that agent's container as `agentclaw-<the same characters>` (an agent made before runtime names had slugs).
- **Cause:** an agent made before runtime names had slugs keeps its old volume name, which the agent's runtime uses. Before `v2.168.0` the backup and the per-agent restore worked the name out by a rule of their own, so the real volume was taken for an orphan and skipped, and the set was never complete.
- **Fix:** upgrade, then run `systemctl --user start hatchabot-backup` (macOS: the backup job) and check the new set is complete.
- **Fixed in:** `v2.168.0`
- **Code:** `src/providers/dockerNames.ts` — `dockerNames`; `src/orchestrator/backups.ts` — `agentArchiveName`; `scripts/backup-volumes.sh` — `vol`

### The `secret-key.env` of a backup set does not decrypt the restored credentials, or the backup says "no .env line reads back as that key everywhere"
- **Check:** `HATCHABOT_SECRET_KEY` in `.env` has a `"` (or `\`, `$`, a backtick) in it; the set's `secret-key.env` wraps it in double quotes.
- **Cause:** before `v2.168.0` the key was written bare in double quotes, and a `"` inside cut it short when the line was read back; the restore drill took the quotes off by hand, so it passed. Now the line is quoted so it reads back whole, and a key holding both a `'` and one of `"` `\` `$` or a backtick is not saved at all and the set is incomplete.
- **Fix:** upgrade and run the backup again. For a key no quoting carries, choose a new passphrase only together with re-entering every stored credential, or keep your own copy of `.env`.
- **Fixed in:** `v2.168.0`
- **Code:** `scripts/backup-volumes.sh` — `parseEnv`; `scripts/restore-drill.sh` — `HATCHABOT_DRILL_KEYFILE`
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
- **Check:** the agent shows failed with "A restore from the YYYY-MM-DD backup failed and could not be undone…"; the log shows `restore.left_failed`; a file `restore-safety-<mark>/<container>-vol-before-restore-<time>.tgz` (`restore-safety/` before this) exists in the backups folder.
- **Cause:** a restore overwrote the agent's volume, then failed, and putting back the copy taken just before also failed (usually a full disk). Before v2.153.0 the agent was restarted on the half-written volume and the message said "left as it was".
- **Fix:** free disk space (`df -h`, `docker system df`). Then restore a backup again from Settings → Backups (allowed on a failed agent), or put the kept copy back by hand while the agent is stopped: `docker run --rm -i -v <container>-vol:/vol alpine sh -c 'find /vol -mindepth 1 -delete && tar xz -C /vol && chown -R 1000:1000 /vol' < <kept file>`. Then tap Retry. Keep the `restore-safety` file until the agent works; Hatchabot does not delete it unless you run `uninstall.sh --purge --backups`.
- **Fixed in:** `v2.153.0`
- **Code:** `src/orchestrator/backups.ts` — `restoreAgentFromBackup`, `restoreSafetyDir`

### A backup set says incomplete: a runner agent's volume failed or is missing
- **Check:** the set's `backup-status.json` lists the volume in `failedVolumes` (and in `missing` if the runner has no volume by that name); the run's log says "on <runner> failed (exit N)" or "that runner has no volume by that name".
- **Cause:** the runner answered but its archive failed (tar error, torn gzip, no `alpine` image), or the agent's volume is not on that runner. Before v2.153.0 the first was recorded as skipped and the set said complete; the second made an empty archive and an empty volume on the runner.
- **Fix:** check the runner (`docker -H <host> volume ls`, `docker -H <host> pull alpine`), then run `scripts/backup-volumes.sh` again. If the volume is gone, rebuild the agent, which makes a new, empty volume, then restore it from its newest set (nothing is pruned while it is missing).
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

### Settings → Backups lists a set from today as complete, but its folder is empty
- **Check:** `ls -la <backups>/<today's date>`: no `hatchabot.sqlite`, no archives, no `backup-status.json`; `journalctl -u hatchabot-backup` (or `--user`): the run ended with "scripts/backup-owner.sh: No such file or directory" or "key_owner: command not found"; `ls -l scripts/backup-owner.sh` in the install.
- **Cause:** the nightly run reads whose a set is through `scripts/backup-owner.sh`. Before v2.178.0 it read that file only after it had made the day's folder, and a missing or unreadable one (a checkout cut off part-way, a permission changed by hand) ended the run there under `set -e`: the empty dated folder, with no record, was listed as a complete set from today. Now the file is read before anything is written, and a run that cannot read it stops there: "✗ Could not read …/scripts/backup-owner.sh: without it this run cannot tell whose the sets in … are, so it stops before writing anything." It does not go on without it, as the restore drill does: the run writes into a set that may be another install's, and could not tell (fifteenth review).
- **Fix:** put it back: on a git install `git checkout -- scripts/backup-owner.sh`, on a bundle install `hatchabot upgrade`, or fix its permissions; remove the empty folder; then "Back up now".
- **Fixed in:** `v2.178.0`
- **Code:** `scripts/backup-volumes.sh` — `key_owner`, `owner`, `OWNER_FILE`

### A restore drill stops at once with "scripts/backup-owner.sh: No such file or directory", and leaves no record
- **Check:** `ls -l scripts/backup-owner.sh` in the install: missing, or not readable by the user the service runs as; Activity shows the drill failed with that line, and no new record is in `<backups>/drills/`.
- **Cause:** the drill reads whose a backup set is through that file. Missing or unreadable (a checkout cut off part-way, a permission changed by hand), it ended the drill before its record could be written. Since v2.178.0 the drill says "Could not read …/scripts/backup-owner.sh: this drill cannot tell whose sets are whose, so it takes the newest complete set and its record names no install." and goes on as an install with no key does, with a record as always.
- **Fix:** put it back: on a git install `git checkout -- scripts/backup-owner.sh`, on a bundle install `hatchabot upgrade`, or fix its permissions; then drill again.
- **Fixed in:** `v2.178.0`
- **Code:** `scripts/restore-drill.sh` — `DRILL_BY`, `key_owner`, `set_owner`

### `restore-drill.sh` fails with only "find: … No such file or directory", or passes on a partial set
- **Check:** `ls "$HATCHABOT_BACKUP_DIR"`; the newest set's `backup-status.json` state.
- **Cause:** before v2.153.0 the drill ran find on a missing folder under pipefail, and drilled the newest set even when its run was incomplete.
- **Fix:** upgrade; it now says there is no backups folder, and drills the newest complete set, naming those it passes over.
- **Fixed in:** `v2.153.0`
- **Code:** `scripts/restore-drill.sh` — `set_state`

### Agent stopped after a restart: "The restore from the … backup was interrupted by a restart"
- **Check:** the agent's page or Alerts shows a held "Restore from a backup"; `GET /v1/operations?agentId=…` returns status `held`, kind `restore-backup`.
- **Cause:** Hatchabot restarted (an upgrade, a crash, a reboot) after the copy of how the agent was had been saved but before the restore finished, so its memory may be half-restored.
- **Fix:** choose **Finish the restore** (that night's copy, with today's members and bot) or **Put back the copy from before**. The copy stays in `restore-safety-<mark>/` beside the backups until you choose.
- **Fixed in:** `v2.155.0`
- **Code:** `src/orchestrator/backups.ts` — `resumeBackupRestore`, `recoverBackupRestore`

### An agent's Recovery row says "left out of the last N backups: its machine was asleep or offline"
- **Check:** Settings → Backups, the "Left out of" column; the machine line shows the runner "not answering"; `<set>/backup-status.json` lists the volume under `skipped`.
- **Cause:** the agent lives on a runner that did not answer at the 03:30 backup, so its volume was skipped (not failed); retention keeps its last copy.
- **Fix:** keep the runner awake at backup time, or run **Back up now** while it is; meanwhile **Download copy** keeps a copy by hand.
- **Fixed in:** `v2.157.0`
- **Code:** `src/orchestrator/recoveryReadiness.ts` — `computeReadiness`

### The last restore drill failed (Alerts: "the last restore drill (<date>) failed")
- **Check:** the drill line in Settings → Backups; the newest `<backups>/drills/*.json`, whose `volumes[].note` is unreadable, layout, extract, timeout, nodocker or missing, and its `database` and `key` fields.
- **Cause:** an archive is torn or holds no OpenClaw files, did not extract into a fresh volume, took over 15 minutes, or Docker did not answer; or one the set's record says was captured is not in the set (missing); or the database copy or the saved key did not pass.
- **Fix:** for an archive, **Back up now** and drill again; for nodocker, start Docker; for the key, compare `secret-key.env` in the set with your `.env`.
- **Fixed in:** `v2.157.0`
- **Code:** `scripts/restore-drill.sh` — `write_record`

### Settings → Backups says the last restore drill passed, but the drill just run failed
- **Check:** Run a drill now (or a scheduled drill) ended with an error in Activity, while the drill line still reads "Last drill … passed"; no new record is in `<backups>/drills/`.
- **Cause:** a drill that fails before it writes its record (it could not start, or stopped first) is only in the server's run state. Before v2.171.0 the line showed that state only when no drill had ever passed, so the older pass hid the new failure.
- **Fix:** upgrade: the line now starts with "The latest restore drill failed: …" in the warning colour, followed by the last drill that finished. Its reason is the drill's last line of output; Activity has the same.
- **Fixed in:** `v2.171.0`
- **Code:** `web/index.html` — `renderDrillRun`; `src/orchestrator/drills.ts` — `startDrill`

### `restore-drill.sh` stops at once with "Another restore drill (pid N) is running"
- **Check:** `<backups>/drills/.lock/pid`, and whether that process is alive.
- **Cause:** one drill at a time — a scheduled drill, Run a drill now, or the live test is already running.
- **Fix:** wait for it; a lock left by a killed drill is taken over by the next one.
- **Fixed in:** `v2.157.0`
- **Code:** `scripts/restore-drill.sh` — `take_lock`

### A restore drill leaves its container, volume and scratch folder behind, and its lock, in a drills folder another user shares
- **Check:** `docker ps -a --filter label=hatchabot.restore-drill` and `docker volume ls --filter label=hatchabot.restore-drill` list drills that are over; `<backups>/drills/.lock` is there with no drill running; `ls -l <backups>/drills` shows a record this user cannot read (another user's install, mode 600).
- **Cause:** before v2.178.0 the drill's last step (the EXIT trap) kept the newest 30 records by reading every one, under `set -e`. A record it could not read failed that step and ended the trap before the cleanup: the container, the volume and the scratch folder stayed, and so did the lock until the next drill took it over. Now the trap cannot stop part-way: the record is written, then the cleanup runs, and only then the pruning, which reads only the records it can and cannot fail.
- **Fix:** upgrade; the next drill clears what a killed drill left. Give each install a `HATCHABOT_BACKUP_DIR` of its own.
- **Fixed in:** `v2.178.0`
- **Code:** `scripts/restore-drill.sh` — `finish`, `cleanup`, `prune_records`

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

### After a restore or import that said "Docker did not respond in time", the agent's files are a mix of old and new
- **Check:** the restore, move or import failed with "Docker did not respond in time" (or the import's Docker client was killed), and the agent's memory or settings afterwards match neither the backup nor what it had before.
- **Cause:** the timeout killed the Docker client and reported the failure at once, while the import container was still being removed. The rollback then extracted into the volume the import container was still writing.
- **Fix:** upgrade; a failed import is reported only after its container is gone, so the rollback has the volume to itself. Restore the agent's last good backup to put a mixed volume right.
- **Fixed in:** `v2.162.0` (#205)
- **Code:** `src/providers/localDockerProvider.ts` — `#oneShotExit`, `importState`, `importWorkspace`, `#runStdin`

### Restoring or importing a damaged file emptied the agent before failing
- **Check:** a restore or import failed with "Couldn't restore the agent's state", and the server log shows `volume import failed` with a tar error ("invalid tar magic", "short read") after the file passed its gzip check.
- **Cause:** the import checked the compression, not the archive inside it. A listing that failed was read as an old-layout archive, so the volume was emptied before extraction found the damage; only the rollback put it back.
- **Fix:** upgrade; the whole archive is read before anything is deleted, and a file that is not a tar archive is refused with "not a valid agent archive" and the agent left as it was. Make a fresh download or backup if the file is damaged.
- **Fixed in:** `v2.162.0` (#213)
- **Code:** `src/providers/localDockerProvider.ts` — `importState`

### After restoring an archive made by hand (`tar czf … .openclaw`), the agent starts empty and its files are under `.openclaw/.openclaw`
- **Check:** `tar tzf <archive> | head` lists `.openclaw/…` with no `./` in front, and `docker run --rm -v <agent's volume>:/v alpine ls -a /v/.openclaw` shows a `.openclaw` folder inside.
- **Cause:** the import told the two archive layouts apart by `./.openclaw/` only. An archive of the home whose paths start `.openclaw/` was taken for the old layout (the contents of `.openclaw`) and unpacked one folder too deep.
- **Fix:** upgrade, then restore or import the archive again; both spellings now unpack into the agent's home.
- **Fixed in:** `v2.171.0`
- **Code:** `src/providers/localDockerProvider.ts` — `importState`

### Import of a downloaded copy freezes the browser for a long while, or the tab dies on a phone, before anything is uploaded
- **Check:** the file is a full copy (a Download, hundreds of MB; a template is a few hundred KB at most). After choosing it, the page stops answering for seconds to minutes with no network traffic in DevTools, or a phone's browser shows "This page is not responding" / reloads the tab. The server log has no `import` line yet.
- **Cause:** before uploading, the page peeked inside every `.hatchabot` file to see whether it was a template that asks setup questions, by decompressing the whole file in the tab and parsing it as JSON. A full copy is a gzipped manifest with the agent's whole volume inlined (up to 256 MB), so the tab held up to about 340 MB of text plus the parsed copy before the upload began.
- **Fix:** upgrade; the peek reads only the first bytes of the file (a template declares itself at the start) and stops within 4 MB, so a copy is uploaded as it is and the server's own bounded peek sorts it out. Before the upgrade: import the copy from a desktop browser and wait, or with the CLI (`hatchabot import <file>`), which does not peek.
- **Fixed in:** `v2.166.0`
- **Code:** `web/index.html` — `peekImportTemplate`, `IMPORT_PEEK_BYTES`, `importAgentFile`; `src/orchestrator/transfer.ts` — `peekFormat`; `scripts/ui-clickthrough.mjs` — `importPeekBounded`

### Two backup runs wrote the same day's set after a killed run
- **Check:** the backup log shows two runs that each said "an earlier run that was killed left its lock … taking it over" for the same set, or the set's record does not match its files.
- **Cause:** a run that found a dead run's lock took it over without checking again; two runs reading the same dead pid both went on, and each one's exit removed the lock while the other was still writing.
- **Fix:** upgrade; taking over a lock is one run at a time and decided again inside, and a run removes only a lock that names it. Run "Back up now" once to rewrite the day's set. A `.backup-lock.takeover` folder older than a minute is cleared by the next run.
- **Fixed in:** `v2.162.0` (#215)
- **Code:** `scripts/backup-volumes.sh` — `lock_busy`, `release_lock`

### A runner's agent stays busy after a backup of it timed out
- **Check:** the backup says `✗ <volume> on <runner> failed (exit 124)`, and `docker -H <runner> ps` still shows an `alpine` container running `tar cz` with that volume mounted.
- **Cause:** the timeout killed only the local docker client; the archive container on the runner went on reading the volume.
- **Fix:** upgrade; the archive container is named and removed (and waited for) when its archive fails or the run ends early. On an older version, `docker -H <runner> rm -f <container>` by hand.
- **Fixed in:** `v2.162.0` (#216)
- **Code:** `scripts/backup-volumes.sh` — `reap_oneshot`

### The nightly backup says a tcp:// runner is "not answering (asleep or offline?)" though its agents run
- **Check:** the runner's address starts `tcp://`; `<set>/backup-status.json` lists its agents under `skipped`; `docker -H tcp://<runner>:2376 --tlsverify version` answers from the Hatchabot machine.
- **Cause:** before v2.171.0 the backup spoke to a runner without `--tlsverify`, though the app speaks to a `tcp://` runner over verified TLS only. A runner set up with TLS did not answer, so its agents were skipped every night; a plain one was read without checking who answered.
- **Fix:** upgrade, then run **Back up now**; the client certificates are the app's (`~/.docker`, or `DOCKER_CERT_PATH` in the service's environment).
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/backup-volumes.sh` — `tls_args`

### After a backup on this machine failed or was stopped, a `tar` container still reads an agent's volume
- **Check:** the run said `✗ <volume> failed (exit N)` with N above 1 (137: killed, 124: timed out); `docker ps --filter volume=<volume>` lists a container running `tar czf /out/<volume>.tgz.part`.
- **Cause:** before v2.171.0 the archive container on this machine had no name, so a docker client that failed or was killed left it running, still writing into the set.
- **Fix:** upgrade; the container is named `hatchabot-bk-…`, labelled and kept off every network as the app's one-shots are, and removed when its client fails or the run ends. On an older version, `docker rm -f <container>` by hand.
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/backup-volumes.sh` — `reap_oneshot`

### A backup run stops with "… is another Hatchabot install's backup set (two installs share …)"
- **Check:** two installs (another `HATCHABOT_PREFIX`, or another machine on a NAS) have the same `HATCHABOT_BACKUP_DIR`; the day's set has a `.backup-owner` file, written by the install that made it.
- **Cause:** each dated set holds one install's registry and key. Before v2.171.0 the second install to run on a day replaced the first one's `hatchabot.sqlite` and `secret-key.env`, beside the first one's archives, so that set no longer restored the first install; and each install's retention pruned the other's old sets.
- **Fix:** give each install a `HATCHABOT_BACKUP_DIR` of its own (a subfolder each on the NAS), then run **Back up now**. Until then the install whose run comes second each day makes no backup at all: its run stops with this line every time, and Alerts soon shows its agents' backups as stale. Sets of another install, or of a former install of this machine with another key, are left for you to delete in Settings → Backups; a set from before v2.171.0 counts as the install's whose key its `secret-key.env` holds, so the second install's older sets are not pruned by the first.
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/backup-volumes.sh` — `OWNER_FILE`; `scripts/backup-owner.sh` — `key_owner`


### Two installs that share a backup folder list, delete and restore from each other's sets
- **Check:** both installs have the same `HATCHABOT_BACKUP_DIR`; `cat <backups>/<date>/.backup-owner` differs between dates; Settings → Backups lists a date this install did not make, or its restore drill passed on one.
- **Cause:** each set is marked with its install in `.backup-owner`, and the nightly run leaves the other install's sets alone. Before v2.178.0 the Backups list, Delete, an agent's Restore, the restore drill and the Recovery row did not look at the mark: one install could delete the other's sets, restore an agent from the other's archive of the same name, and prove its readiness with the other's set or drill record. Now each reads the owner as the nightly run does (the mark, or for a set from before it, the key the set saved). Such a set is listed labelled "made by another install, or under an earlier key", never deleted from here, never this install's newest set (nor the one the home screen's backup line or `hatchabot doctor` judges), and restored only on a yes; drill records carry their install's mark, the folder keeps the newest 30 of each install's (each install prunes only its own: a drill of another install's set from here is recorded as that install's and never prunes its records), and the Recovery row reads this install's own. An agent's readiness (ready, stale, not covered, never drilled) comes from this install's sets only: another install's newer set holding an archive of the same name is offered in Restore…, labelled, and named in the row ("A newer copy made by another install, or under an earlier key, is from …"), but it no longer makes the agent ready or covered when this install's own newest set left it out. Settings → Backups' "Latest usable" column shows this install's own newest too, with another install's newer copy named beside it. Restore… chooses this install's own newest set (`ownLatest`) first, and another install's only when there is none of its own (restoring from it still asks). Its list of choices (14 at most) keeps this install's own sets first and fills the rest with the other install's newest: before the tenth review it was the 14 newest of all, and 15 newer sets of another install's left the own one out, so Restore… could not choose it. A drill asked for another install's set by path says so, goes on, and records it as that install's. A set from before the mark whose saved `secret-key.env` holds no key names no install, in the app as in the scripts (fifteenth review: the app took it for the running service's own key's).
- **Fix:** upgrade, and give each install a `HATCHABOT_BACKUP_DIR` of its own.
- **Fixed in:** `v2.178.0`
- **Code:** `src/orchestrator/backups.ts` — `foreignSet`, `setOwner`, `listBackups`, `pruneBackup`, `restoreAgentFromBackup`; `src/orchestrator/recoveryReadiness.ts` — `computeReadiness`, `ownLatest`; `web/index.html` — `v2RecoveryToggle`, `loadReadiness`; `src/orchestrator/drills.ts` — `listDrills`; `src/doctor.ts` — `backupFacts`; `scripts/restore-drill.sh` — `foreign_owner`, `RECORD_OWNER`, `DRILL_BY`, `write_record`, `prune_records`; `scripts/backup-owner.sh` — `key_owner`, `set_owner`; `web/index.html` — `v2LoadMachine`

### After a reinstall, Backups says the older sets were "made by another install, or under an earlier key"
- **Check:** the sets before the reinstall (or before `HATCHABOT_SECRET_KEY` was changed by hand) carry that label in Settings → Backups and have no Delete; an agent's Restore from one says why and asks first; `cat <backups>/<date>/.backup-owner` differs from a set made since.
- **Cause:** a set is marked with a fingerprint of the key it was made under, and nothing tells another install from this one under its earlier key. The label is expected: the nightly clean-up and Delete leave such a set alone, so another install's sets are never removed from here. For the same reason an agent backed up only before the reinstall shows "None of this install's backups holds it. A copy made by another install, or under an earlier key, is from …" (not covered) until the next nightly backup takes it; Restore… still offers that copy.
- **Fix:** nothing to fix. Restore an agent from one when asked to confirm (`hatchabot backups restore <agent> <date> --yes --other-key` from the command line): the agent's memory and files come back and its current bot, members and model go back over them, so the earlier key does not matter for it. A whole-install restore takes the set's own `secret-key.env` (README, "Restoring from backup"). Once you no longer want the old sets, delete their dated folders by hand.
- **Fixed in:** `v2.178.0`
- **Code:** `src/orchestrator/backups.ts` — `foreignSet`, `RESTORE_ASKS`, `NOT_DELETED_HERE`; `src/orchestrator/recoveryReadiness.ts` — `computeReadiness`; `web/index.html` — `restoreFromBackup`

### `restore-drill.sh` run by hand says "No backups directory at ~/hatchabot-backups" though backups run elsewhere
- **Check:** `HATCHABOT_BACKUP_DIR` is set in the install's `.env` but not in your shell; Settings → Backups lists sets.
- **Cause:** before v2.171.0 the drill read only the environment it was started with, not `.env` as the backup script and the app do.
- **Fix:** upgrade; until then run it as `HATCHABOT_BACKUP_DIR=<folder> ./scripts/restore-drill.sh`, or with **Run a drill now** in the app.
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/restore-drill.sh` — `parseEnv`

### Two restore drills ran at once after a killed drill, both saying "an earlier drill that was killed left its lock"
- **Check:** the drill output (or the app's drill summaries) shows that line twice at about the same time; `<backups>/drills/` has two records started together.
- **Cause:** before v2.171.0 a drill that found a dead drill's lock took it over without checking again, so two drills that read the same dead pid both went on, and either one's exit removed the lock the other still used.
- **Fix:** upgrade; a takeover is one drill at a time and decided again inside, and a drill removes only a lock that names it. A `.lock.takeover` folder older than a minute is cleared by the next drill. A lock whose pid is another user's process (another install drilling the same folder) holds for 3 hours from when it was taken, then is taken over.
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/restore-drill.sh` — `take_lock`, `lock_busy`, `pid_alive`

### A restore drill failed with "failed to extract into a fresh volume" while another install's drill started on the same Docker
- **Check:** two installs with different backups folders use one Docker; the failed drill's record has `note` extract; `docker ps -a --filter label=hatchabot.restore-drill` showed the other's `hatchabot-restore-drill-…` container then.
- **Cause:** before v2.171.0 a drill removed every drill's containers and volumes before its own, as if left by a killed drill, though the lock it held was only its own folder's.
- **Fix:** upgrade, then run the drill again. A drill's throwaways are labelled with its backups folder; a drill removes its own folder's leftovers, and another's only once that drill's process is gone.
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/restore-drill.sh` — `DRILL_OWNER`, `drill_gone`

### A restore drill passed although an agent's archive was gone from the set
- **Check:** the set's `backup-status.json` lists the volume under `captured`, but `<set>/<volume>.tgz` is not there; the drill's record has no entry for that volume (before v2.171.0), or one with note `missing`.
- **Cause:** before v2.171.0 the drill checked only the archives it found in the set, so a captured archive that had been deleted or moved since was simply left out, and the drill said the backup would bring the system back.
- **Fix:** upgrade; the drill now fails and names each such volume. Run **Back up now** for a set that holds every agent, and look for what removed the file (a cleanup by hand, a sync tool on a NAS).
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/restore-drill.sh` — `missing`; `src/orchestrator/recoveryReadiness.ts` — `drillChecks`

### Deleting a backup says "The … backup is a link to a folder elsewhere", or a moved set keeps a `.backup-lock` it should not
- **Check:** `ls -l <backup dir>` shows that date as a link (`->`) to another folder; a set reached through such a link may hold `.backup-lock/pid` naming the Hatchabot server's pid.
- **Cause:** before v2.171.0 Delete followed the link: it wrote its lock into the folder the link points at, removed only the link, and left that lock behind, so later runs and deletes in that folder saw it as busy.
- **Fix:** upgrade; Delete now refuses a link and touches nothing. Remove the link (or the folder it points at) by hand after a look; remove a leftover `.backup-lock` there with `rm -r`.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/backups.ts` — `pruneBackup`

### A restore drill says "passed", or a backup set "complete", though it was stopped part-way
- **Check:** the drill hit its 90-minute limit, or the service restarted (a deploy, an upgrade, `hatchabot restart`) or the machine shut down during a drill or a backup; yet Settings → Backups shows that drill passed, or the set complete, and volumes after the stop were never read or captured.
- **Cause:** both scripts write their verdict in an EXIT trap. Stopped by a signal, bash ran that trap with the last finished command's status, 0, so the verdict was "passed" or "complete".
- **Fix:** since the fix a signal ends them through an exit of 130, 143 or 129, so a stopped drill is recorded failed and a stopped set incomplete. For a set recorded before, run Back up now; for a drill, run a drill again.
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/backup-volumes.sh` — `finish`; `scripts/restore-drill.sh` — `finish`

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

### After a budget pause ends, the agent stays on the cheaper model for good
- **Check:** in one pass, one budget moved the agent to a cheaper model and another paused it (the 80%/100% messages arrive together); after the 1st, or a raised budget, it runs on the cheaper model.
- **Cause:** before `v2.168.0` the pause judged the agent as the pass first read it, missed the cheaper model just set, and its record replaced the one that remembered the agent's own model.
- **Fix:** upgrade, and set the agent's model again on its page (AI). Now the agent's own model is put back before the pause.
- **Fixed in:** `v2.168.0`
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

### The 1st came, or the budget was raised, and an agent paused by its budget is still stopped
- **Check:** the agent's card says "A change is waiting", and its Activity list has a failed rebuild, "Not rebuilt: …", from about that time. The budget still shows it paused.
- **Cause:** a change saved while it was paused made its next start a rebuild, and that rebuild was refused (a source with a missing key, say). The agent stays stopped as it was. On an older version the pause was closed all the same, as if it had started.
- **Fix:** fix what the refusal names, then press Start. Left alone, a pause is tried again about every six hours, and closes once the agent is up.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/budgets.ts` — `runBudgets`; `src/api/routes.ts` — `runBudgetPass`, `startStopped`

### 100 messages wait for an agent paused by its budget, and whoever writes after them gets no paused reply
- **Check:** the agent's Activity says "100 messages wait for it on Telegram: whoever writes after them gets no paused reply until it is back" (from v2.178.0).
- **Cause:** a limit of Telegram. One look at a bot's waiting messages shows the first 100, and the only way to see more is to confirm those, which takes them from the agent for good. Hatchabot never confirms them, so the agent reads them all when it is back; whoever wrote after the first 100 gets no paused reply.
- **Fix:** raise the budget or Start the agent, and it answers everyone in turn. A group chat or a busy chat can fill the 100 alone.
- **Fixed in:** — (a limit; from `v2.178.0` the agent's Activity says when it is reached)
- **Code:** `src/orchestrator/budgets.ts` — `pausedReplySweep`

### A budget raised, removed or set to warn while agents were being paused, and the rest were paused anyway
- **Check:** the machine's budget (or an agent's) was changed while a budget check was stopping agents or moving them to a cheaper model; agents after the change were still stopped or moved, and the 100% message came for the old budget. With the fix the service log shows `budget.revised_during_pass`.
- **Cause:** a budget check read the budgets once and acted on that reading for every agent, though each stop can take a while.
- **Fix:** upgrade, then Start the agents that were stopped (or raise the budget, and the next check starts them). Now the budget is read again before each stop and each switch; a budget that changed is left to the check its change starts. An agent whose own model was being put back for the pause when the budget changed says "back on its own model: its budget was changed". A pause that fails after an agent's own model was put back for it puts the cheaper model back, logged in its model history as the budget's switch (or, if its runtime does not take it, ends the switch the same way), so the next check does not take its own model for the owner's choice and leave it there until the 1st.
- **Fixed in:** `v2.178.0`
- **Code:** `src/orchestrator/budgets.ts` — `runBudgets`, `putCheaperBackOrClose`; `src/api/routes.ts` — `reapplyCheaper`

### You pressed Stop on an agent whose budget pause had just ended, and the next budget check started it
- **Check:** its Activity shows a rebuild that brought it up, your Stop, then within about 10 minutes "started again: its budget was raised" (or "a new month"), on a release before the fix. With the fix it shows `budget.pause_disowned` at the Stop and then `budget.pause_closed`, and it stays stopped.
- **Cause:** a pause on an agent that owed a rebuild stays open until a budget check finds the agent up. Stopped before that check, it read as stopped by the budget, so the end of the pause started it. Draining its machine did the same, and putting it to sleep woke it.
- **Fix:** stop it again after upgrading. A Stop, a drain or a sleep now takes the pause over: it closes with no start, and Start still works as usual.
- **Fixed in:** `v2.173.0`
- **Code:** `src/store/store.ts` — `disownBudgetPause`; `src/api/routes.ts` — `disownPauseOnStop`; `src/orchestrator/budgets.ts` — `runBudgets`

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

### An AI source shows fewer refused (rate-limited) calls than its agents' logs, or a refusal no model call made
- **Check:** `docker logs --timestamps <container> | grep 'model-fetch] response.*status=429'` shows two refusals in the same millisecond, or the line counted has the `[model-fetch] response` marker quoted inside another line (a message or a tool's output) rather than at its start.
- **Cause:** refusals were keyed by agent and millisecond, so the second of two in one millisecond was dropped; a marker anywhere in a line counted as a call; and the log's stdout and stderr shared one line buffer, so a half line of each could be joined and the call lost.
- **Fix:** upgrade; nothing to do by hand. Each refusal is kept by its log line's own stamp, only OpenClaw's own lines count, and each stream is read on its own.
- **Fixed in:** `v2.169.0`
- **Code:** `src/orchestrator/sourceUsage.ts` — `parseModelCalls`; `src/store/store.ts` — `addLimitHit`; `src/providers/localDockerProvider.ts` — `modelCallLog`

### After a rebuild that switched an agent's AI source, its last hour of calls shows under both sources
- **Check:** Usage for the old and the new source both show the same calls in the hour before the rebuild (the agent's requests are about doubled across the two).
- **Cause:** before v2.162.0 each sample rewrites the last hour of successful calls from the transcripts, and filed all of it under the source running now, while the old source still had those calls.
- **Fix:** upgrade. A rebuild that changes the source records when it did; calls before that time stay with the old source and only later ones go to the new source. Counts from before the upgrade are not corrected.
- **Fixed in:** `v2.162.0`
- **Code:** `src/orchestrator/sourceUsage.ts` — `sampleAgentUsage`; `src/store/store.ts` — `setAgentApplied`

### After two AI-source switches within an hour, the first source's calls also show under the second
- **Check:** the agent was rebuilt onto one source and then another within about an hour (a fallback while rate-limited, say); Usage shows the second source with the first one's calls added, so the three sources together count more requests than the agent made.
- **Cause:** only the latest switch was remembered, so each reading filed every call before it under the source it switched from, including calls the first source had made.
- **Fix:** upgrade; every switch is kept for the week the usage history covers, and each call stays with the source that made it. Counts recorded before the upgrade are not corrected.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/sourceUsage.ts` — `sampleAgentUsage`; `src/store/store.ts` — `setAgentApplied`, `appliedSourceChanges`

### The Cost view's figures stay on the old window after pressing another (1 hr, 1 day …)
- **Check:** the pill is on the new window but the chips still show the old one's suffix (for example `/wk`), until the next poll five minutes later.
- **Cause:** before v2.160.0 a pill pressed while the previous figures were still loading was dropped, and the discarded answer still counted as fresh.
- **Fix:** upgrade: the new window's figures are read as soon as the earlier answer is back. Reloading the page also shows them.
- **Fixed in:** `v2.160.0`
- **Code:** `web/index.html` — `v2LoadCosts`

### Usage → Spend over time shows another range than the one picked, or everyone's total under one agent's name
- **Check:** you pressed a range (1 day after 1 wk) or ticked agents in the picker while the chart was loading; the pill says one range and the bars show another, or the picker names one agent while the total is all of them.
- **Cause:** each press started another read of the same chart, and an earlier, slower answer was drawn over the latest.
- **Fix:** press the range again. Since v2.168.0 only the chart's latest read is drawn.
- **Fixed in:** `v2.168.0`
- **Code:** `web/index.html` — `loadSpendChart`, `spendChartSeq`

### Usage → Spend over time says $0.00 (or too little) for a model that costs money
- **Check:** the agent runs a cloud model Hatchabot has no price for (Settings → AI sources → Model prices lists it under "No price known"); the chart counts its tokens, but the pies say $0.00, or less than the agent spends.
- **Cause:** tokens on a model with no known price were counted at no cost, and the chart did not say so.
- **Fix:** read that model's cost from the provider's own console. Since v2.168.0 the chart says "No price" when nothing in the range has a price, adds "+" when part of it has none, and names the models and tokens left out.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/agentCosts.ts` — `spendSeries`, `unpriced`; `web/index.html` — `spendChartHTML`

### The app stops answering everyone after a Usage chart request with an odd range
- **Check:** the service log's last request before it stopped is `GET /v1/usage/spend?range=constructor` (or `__proto__`, `toString`); the process is up, busy on a full CPU core, and answers nothing until it is restarted.
- **Cause:** the range was checked with `in`, which also accepts names every JavaScript object has, and the chart's slice loop then never ended. `GET /v1/costs?period=` had the same check and answered nonsense instead.
- **Fix:** restart the service. Since v2.168.0 only the chart's own range names (and View by → Cost's own windows) are accepted, anything else is a 400, and the slice loop is bounded.
- **Fixed in:** `v2.168.0`
- **Code:** `src/orchestrator/agentCosts.ts` — `isSpendRange`, `isCostPeriod`, `sliceStarts`; `src/api/routes.ts` — `'/v1/usage/spend'`, `'/v1/costs'`

### A context cap removed or moved, but a hand edit of the provider vanished, or the old model still compacts early
- **Check:** in the agent's console, `openclaw config get models.providers.<provider>`: a `baseUrl` or model row you added is gone after taking a context cap off, or after a source switch the old provider still has a row with `contextTokens`; the event log has `token.context_cap_failed`.
- **Cause:** taking the last cap off ran `config unset` on the whole provider entry without checking it was still what Hatchabot had read; and after a source switch a failed removal of the old provider's cap was forgotten once the new cap was written.
- **Fix:** upgrade; put back the hand edit, or take the stale `contextTokens` row off by hand. Since v2.160.0 the entry is read again just before the unset and left alone if it changed, and the old cap stays on record until it is off, so the next rebuild or change retries it.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/compaction.ts` — `syncContextCap`, `writeEntry`

### On the 1st, or after a budget was raised, agents you had stopped by hand started again
- **Check:** the agents were stopped by you, not by a budget, when a "pause" budget (theirs or the machine's) reached 100%; each one's timeline shows `budget.paused` with `alreadyStopped: true`, then `budget.resumed` with `new-month` or `budget-raised`, and the agent is RUNNING.
- **Cause:** v2.165.0 began recording a pause for an agent that was already stopped (so Start could be the owner's take-over it promised), but recorded it like any pause, and the pass that ends pauses started every open one. A machine budget's pool is every agent, so each hand-stopped agent started on the 1st and began spending.
- **Fix:** upgrade, and stop the agents again. The record now remembers that the budget stopped nothing: it closes on the 1st or a raise with no start (`budget.pause_closed`), and the 100% message says "it was already stopped, so it stays stopped" (or how many "already stopped stay so").
- **Fixed in:** `v2.166.0`; `v2.169.0` for a pause v2.165.0 had already recorded before the upgrade (still read as the budget's own; it is now marked from its `budget.paused` event)
- **Code:** `src/orchestrator/budgets.ts` — `runBudgets`, `alreadyStopped`, `budgetMessage`; `src/store/store.ts` — `addBudgetPause`, `already_stopped`, `2026-10-26-budget-pause-already-stopped`
### Usage → Spend over time: the day you deleted your last agent shows less than it spent
- **Check:** every agent of yours was deleted (or the last one was) after it had been working that day; the day's bar in Spend over time is lower than the Usage tab showed before the delete, and it stays so the next day, while a day on which some agent of yours survived is right.
- **Cause:** the daily point was made for the owners of active agents only. Once your last agent was gone, your days were never finished, so the readings its last hours had added were never counted, though deleted agents' use is meant to stay (v2.164.2).
- **Fix:** upgrade: owners with a deleted agent are finished too, and the next daily pass takes the readings in. Nothing to do by hand.
- **Fixed in:** `v2.166.0`
- **Code:** `src/orchestrator/fleetUsage.ts` — `snapshotDailyUsage`; `src/store/store.ts` — `deletedAgentOwners`

### A context cap changed while the agent was stopped, or taken off just after it was set, did not take effect
- **Check:** in the agent's console, `openclaw config get models.providers.<provider>` shows the old `contextTokens` (or one at all, after the cap was taken off); Usage shows the new cap, or none.
- **Cause:** the background pass that writes a waiting cap compared only the model it was written for, so a new size on the same model looked done. And a removal answered while the first write of the cap was still running; that write then put the cap in with no record left to take it out.
- **Fix:** upgrade, then set the cap again (or take it off again). Since the fix a cap saved after it was last written is written at the next pass, and cap writes for one agent run one at a time, each reading the cap as it is when its turn comes.
- **Fixed in:** `v2.171.0`
- **Code:** `src/api/routes.ts` — `runTokenSteward`; `src/orchestrator/compaction.ts` — `syncContextCap`; `src/store/store.ts` — `markContextCapApplied`

### A budget's switch to a cheaper model fails, and the model you chose meanwhile is lost
- **Check:** the agent's monthly budget is set to "switch to a cheaper model", its Setup log has `model.live_set_failed` for the cheaper model, and a model you chose about then said it applied live, yet the agent's page shows its earlier model (or its source's default).
- **Cause:** when the runtime refused the cheaper model, the budget put back the model it had read before, over the one chosen while it waited. That choice was then applied as the old model.
- **Fix:** upgrade: the budget puts back only its own change, so a model chosen meanwhile stands and goes on, even the same cheaper model, as does a source switched meanwhile. A source's new default that held the agent on the cheaper model meanwhile is not a choice: the budget's change goes back then too, and an agent that followed the old default is held on it. A class's model written while the switch applied (the switch's pause is open from the start) is the one put back. Until then, choose the model again.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `runBudgetPass`, `applyModelToRuntime`, `driftedFrom`; `src/orchestrator/budgets.ts` — `runBudgets`; `src/store/store.ts` — `modelGeneration`, `setAgentModel`, `openCheaperPause`, `dropCheaperPause`

### Brave searches this month leaves out the first days, on a plan that resets on the 29th, 30th or 31st
- **Check:** Settings → AI → Fleet search key → Brave searches this month says the month runs from the 1st to the 3rd (say "3 March to 31 March") when Brave's plan resets on the 31st, and the days before it are missing from the bars.
- **Cause:** the month before the reset was found by taking one off the month and keeping the day. A day the month before does not have (31 February) ran on into the next month.
- **Fix:** upgrade. The month starts on the same day of the month before, or on its last day when it is shorter (28 February for a reset on 31 March).
- **Fixed in:** `v2.178.0`
- **Code:** `src/orchestrator/searchUsage.ts` — `monthBefore`, `searchPeriod`

### Brave searches this month counts an agent's own Brave key against the fleet's free credit
- **Check:** the agent has `BRAVE_API_KEY` in its Environment tab, and its searches show in the Brave column, the credit used and the estimated cost, though its key is billed on its own.
- **Cause:** searches were stored by the provider that answered, without which key made them, so every Brave search counted as the fleet key's.
- **Fix:** upgrade. Searches an agent makes with its own key are stored apart from when they are counted, and listed as its other searches. The split starts at the upgrade: searches counted before it stay in the Brave column, against the fleet's credit, so the month of the upgrade still shows some of an agent's own-key searches there. The key that counts is the one its container was built with: a key saved or taken off in the Environment tab counts from the agent's next rebuild, when it reaches the agent. Until an agent's first rebuild after the upgrade, its saved key is used, and one equal to the fleet's key counts as the fleet's, as the build does. Searches already counted keep the key they were counted under: in an hour a rebuild changed the key in, only the searches after it go under the new key.
- **Fixed in:** `v2.178.0`
- **Code:** `src/orchestrator/sourceUsage.ts` — `attributeBrave`, `ownSearchKey`, `storeSearchHours`; `src/orchestrator/searchUsage.ts` — `OWN_BRAVE`, `searchUsageReport`; `src/orchestrator/provision.ts` — `recordApplied`

### Brave searches this month misses the 1st of a 31-day month, just after upgrading
- **Check:** search counting was new (an upgrade to v2.177.0, or an agent counted for the first time) on the 31st; the bar for the 1st is empty though the agent searched that day.
- **Cause:** the first reading went back 30 days. On the 31st that does not reach the start of the month, and nothing before it was stored.
- **Fix:** upgrade. The reading goes back 32 days, so a month of any length is covered. No reading lowers a stored hour: each hour keeps the larger of its stored count and the reading's, so searches counted before a session was reset, deleted or pruned stay counted.
- **Fixed in:** `v2.178.0`
- **Code:** `src/orchestrator/usage.ts` — `USAGE_READER_SCRIPT` (`SW`, `srch`, `seenFrom`); `src/orchestrator/sourceUsage.ts` — `storeSearchHours`

### Token health says AGENTS.md is cut off, or its instructions are too big, for an agent that writes in Chinese, Japanese or another script
- **Check:** the agent's instruction files hold text outside plain English letters; the Hatchabot agent's token review (or `GET /v1/token-health`) gives sizes up to three times what the file holds, and says a file is over 20,000 characters when it is not. Or `TOOLS.md` is counted in every turn on OpenClaw 2026.9.6 or later, which does not load it.
- **Cause:** the reader measured each file in bytes, while OpenClaw's limits count characters, and it counted `TOOLS.md` on every OpenClaw version.
- **Fix:** upgrade. Files are measured in characters, and `TOOLS.md` is left out on an OpenClaw that does not put it in the prompt. The next usage pass (every 10 minutes) puts the figures right. Each count is kept by the file's size and time in `/home/node/.openclaw/tmp/hatchabot-instruction-sizes.json` inside the agent (left out of snapshots), so a file is read again only once it changes; removing that file only makes the next pass read them all.
- **Fixed in:** `v2.178.0`
- **Code:** `src/orchestrator/usage.ts` — `USAGE_READER_SCRIPT` (`files`, `knownSizes`, `ocv`); `src/orchestrator/tokenHealth.ts` — `promptFiles`, `injectedSize`

### The Costs chart under an AI source stayed the same while Settings was open
- **Check:** Settings → AI sources stayed open while agents worked. The Costs chart under a source did not change, though Usage showed new spend. Closing and opening Settings updated it.
- **Cause:** the regular poll updated each source's status line only. The chart was read only when the list was drawn.
- **Fix:** close and open Settings. Since the fix, the poll reads a chart again at most once a minute while its Costs drawer is open and on screen. If that read fails, the chart stays as drawn with a short note under it.
- **Fixed in:** `v2.178.0`
- **Code:** `web/index.html` — `loadSourceUsage`, `loadSpendChart`

### Fable 5.2 has "no price known", or Sonnet 5.5's cache reads cost twice what Anthropic charges
- **Check:** Settings → AI sources → Model prices has no Fable 5.2 row, or lists Sonnet 5.5's cache reads at $0.20 per million tokens.
- **Cause:** the price list was last read from Anthropic's pricing page on 2026-10-03, before Fable 5.2, and gave Sonnet 5.5 the usual tenth for a cache read where Anthropic charges a twentieth.
- **Fix:** upgrade. Fable 5.2 is priced at $8 in and $40 out per million tokens, cache reads at $0.20; Sonnet 5.5's cache reads at $0.10. Within ten minutes, costs and budget spend for the last 30 days are worked out again at these prices (from the hourly token counts); older days keep what they were counted at.
- **Fixed in:** `v2.179.1`
- **Code:** `src/orchestrator/pricing.ts` — `MODEL_PRICES`, `CACHE_READ_SHARE`; `src/orchestrator/modelOptions.ts` — `MODEL_CATALOG`

## Scheduled tasks

### No note on your phone when a scheduled task has run
- **Check:** on the agent's Schedule tab, the task has **📱 Tell me on Telegram when it runs** ticked, and the tab says nothing above the tasks about your Hatchabot agent's bot (it does while no bot can reach you). The agent's activity log says "told you on your phone that "…" ran" or "could not tell you on your phone …" for each run it looked at.
- **Cause:** the note comes from your Hatchabot agent's own Telegram bot (or its Discord bot), not from the agent that ran the task: with no bot there, or one you have never messaged (it does not know where you are), there is nowhere to send it. Runs are looked at every 5 minutes while the agent is running, so a run made just before it went to sleep is told when it next runs, saying how long ago. A skipped run is not told. At most 10 notes an hour reach you; the tenth says it is the last for the hour. The run is read from OpenClaw's task store, which needs OpenClaw 2026.9 or later in the agent.
- **Fix:** give the Hatchabot agent a Telegram bot (its Telegram tab, **Connect**) and send it a message, then tick the box on each task to be told about, or tick it in the form when adding one. The note holds the task's name, the agent's and a link that opens the agent's console; the result stays in Hatchabot.
- **Fixed in:** `v2.177.0` (new: before it, only an agent's own bot brought a task's result to a phone)
- **Code:** `src/orchestrator/taskNotes.ts` — `dueTaskNotes`, `taskNoteText`, `TASK_NOTES_PER_HOUR`; `src/orchestrator/crons.ts` — `readCronStore`, `cronStoreReadShell`; `src/api/routes.ts` — `noteFinishedTasks`, `quickCronRetarget`, `ownerNoteReach`; `src/store/store.ts` — `cronNotes`, `setCronNote`, `markCronNoted`; `web/index.html` — `cronNoteBox`, `setCronNote`, `cronNoteHint`

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

### A copy made from a template is missing one of the template's scheduled tasks, and a rebuild does not bring it back
- **Check:** the template (or the original) has the task, the copy's Scheduled tasks list does not, and the copy's Setup log has `schedule.apply_failed` (or `schedule.list_failed`) from its first setup.
- **Cause:** a task the gateway refused while the copy was being set up stays parked to be tried again, but before v2.168.0 only a setup tried again, and the copy was already running; a rebuild never did.
- **Fix:** upgrade. From v2.170.0 the copy's Schedule tab lists the task as "waiting to be added" with the reason it was refused; **Try adding it now** adds it, and a Start, a wake or a rebuild tries again too (each once; one already there by name is not added again). On v2.168.0 and v2.169.0, Rebuild the copy. On an older version, add the task by hand on the copy's Schedule tab.
- **Fixed in:** `v2.168.0` (a rebuild); `v2.170.0` (shown, Try again, Start and wake)
- **Code:** `src/orchestrator/provision.ts` — `applyPendingSchedules`, `retryPendingSchedules`, `retryPendingSchedulesWhenUp`, `rebuildAgent`; `src/api/routes.ts` — `waitingTasks`, `clearPinsWhenUp`, `'/v1/agents/:id/crons/waiting'`; `web/index.html` — `cronWaitingRows`, `retryWaitingCrons`

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

### A shared copy of an agent with Setup fields is missing a change the agent made to its own AGENTS.md
- **Check:** the agent has Setup fields; its live AGENTS.md (or SOUL.md) has text the copy lacks, and that text was written by the agent itself or in its console, not saved in the app's Files editor.
- **Cause:** an agent with Setup fields travels as its setup version, `{{placeholders}}` and all, so a copy can give its own answers. A Files editor save updates that version; a change made any other way does not, and before v2.169.0 the copy left it out without a word.
- **Fix:** upgrade: Share a copy and Send to someone name the files that changed this way before anything leaves. To include the change, open the file in the agent's Files and save it there, putting `{{field}}` back wherever a copy should give its own answer; then share again.
- **Fixed in:** `v2.169.0`
- **Code:** `src/orchestrator/template.ts` — `exportTemplate`; `web/index.html` — `editedNote`, `personalCheck`, `openSendAgent`

### Import or New child: "… must be yes or no (true/false)"
- **Check:** the answer given for a yes/no setup field (from the CLI, a script, or the field's declared default) is not one of yes, no, true, false, on, off, 1, 0.
- **Cause:** before v2.160.0 any other answer, such as a misspelt "tru", was taken as no and turned the option off without a word.
- **Fix:** give yes or no; if the template's own default is the misspelt one, fix it in the master's Setup fields and share again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/template.ts` — `resolveParamValues`

### New child, Import or Accept: a setup answer you cleared came back as the template's default
- **Check:** the setup form showed a default (some text, or ticked options) and you emptied it before Continue; the new agent's SOUL.md or AGENTS.md (or its Setup values) has the default.
- **Cause:** an emptied optional field was left out of the answers, and the server fills a missing answer with the field's default.
- **Fix:** clear it in the new agent's Setup values, which sends an emptied answer as empty. Since v2.168.0 the setup form does too, for a default you cleared.
- **Fixed in:** `v2.168.0`
- **Code:** `web/index.html` — `submitParamForm`, `collectSetupValues`; `src/orchestrator/template.ts` — `resolveParamValues`

### New child, Import or Accept: a yes/no setup field whose default is "yes" (or "on", "1") starts unticked, and the agent gets no
- **Check:** the template's default for the field is written yes, on, 1 or in capitals, not "true".
- **Cause:** the form ticked the box only for a default of exactly "true", then sent "false" for the unticked box, though the server reads all of these as yes.
- **Fix:** tick it in the new agent's Setup values. Since v2.168.0 the form and Setup values read a default the way the server does.
- **Fixed in:** `v2.168.0`
- **Code:** `web/index.html` — `paramYes`, `collectParamValues`, `renderSetupValues`; `src/orchestrator/template.ts` — `resolveParamValues`

### A choice in a template's setup fields is never accepted, or a template with two fields of the same key imports wrongly
- **Check:** the field's options in the template have spaces before or after them (`" daily"`), or two of its setup fields share one key.
- **Cause:** answers were compared trimmed against options that were not, so such an option could never be picked; and two fields of one key overwrote each other's answer. Before v2.160.0 both were accepted when the template was made or imported.
- **Fix:** upgrade: options are trimmed where they are declared and compared trimmed, and a template whose keys repeat is refused as malformed. Fix the repeated key in the master and share again.
- **Fixed in:** `v2.160.0`
- **Code:** `src/orchestrator/template.ts` — `TemplateParamSchema`, `parseTemplate`, `resolveParamValues`

### Importing a template with long setup answers says only "Import failed" (or, from v2.166.0, "The setup answers are too long to send together")
- **Check:** the template asks several setup questions and the answers are long (about five full-length answers of 2,000 characters, fewer if they hold many spaces or punctuation). In DevTools → Network the `POST /v1/agents/import?values=…` request has a very long address and the answer is a `431` with no body; the server log shows nothing, because Node refused the request before the app saw it.
- **Cause:** the setup answers travelled in the request's address, and Node refuses a request whose address and headers together pass 16 KB. The page showed the empty answer as a bare "Import failed"; v2.166.0 only refused before sending, saying how many characters were over.
- **Fix:** upgrade: the page sends the answers in the request body, ahead of the file (`application/vnd.hatchabot.import`), so every answer a template allows goes through. On an older version, shorten some answers and finish the rest in the agent's Overview after the import (Setup values). A script that still sends `?values=` keeps working within the address's limit.
- **Fixed in:** `v2.170.0` (`v2.166.0` refused in words)
- **Code:** `web/index.html` — `IMPORT_WITH_VALUES`, `importAgentFile`; `src/api/routes.ts` — `IMPORT_WITH_VALUES`, `IMPORT_HEAD_MAX_BYTES`, `'/v1/agents/import'`; `scripts/ui-clickthrough.mjs` — `importAnswersInBody`
### An agent made from a template cannot be edited or snapshotted: "SOUL.md is over 256KB", though the template was small
- **Check:** the template imported fine, but editing the agent's SOUL.md or AGENTS.md in the app says it is over 256KB, snapshots and Download copy refuse it, and the template file itself is a few KB. Its files use a setup field many times, and the answer given was long.
- **Cause:** a template's files were held to the core-file limit as written, with their `{{placeholders}}`; the file as rendered with the answers was not. A 9 KB file with 1,000 placeholders and a 2,000-character answer became a 2 MB SOUL.md.
- **Fix:** upgrade: the import, a Setup values edit and a push to derived children refuse a rendering over the limit before anything is made or written, naming the file. For the agent already made, give a shorter answer under Setup values, which renders the file again within the limit; or trim the master's file and share again.
- **Fixed in:** `v2.166.0`
- **Code:** `src/orchestrator/template.ts` — `renderedTooBig`, `importTemplate`; `src/api/routes.ts` — the `'/v1/agents/:id/params'` and `'/v1/agents/:id/push-definition'` routes

### Setup values failed with "Write failed", and now SOUL.md has the new answer while AGENTS.md and the values panel have the old one
- **Check:** the agent's Setup values edit answered "Write failed" (a full disk, a runner that went to sleep part way); its SOUL.md shows the new answer, its AGENTS.md (or the Setup values panel) the old one.
- **Cause:** before v2.168.0 Setup values wrote SOUL.md, then AGENTS.md, and stopped at the first that failed: what was already written stayed, while the stored values were not changed.
- **Fix:** upgrade: a file that cannot be written puts back the ones already written, and the error says "Nothing was changed" (or names a file it could not put back: restore the agent's `pre-params` snapshot). On an older version, apply the values again once the disk or machine is fine, or restore the `pre-params` snapshot.
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/params'`

### Setup values change AGENTS.md but never SOUL.md (or the other way round) on an agent whose fields were declared on it
- **Check:** the agent has no imported setup layer (its fields were declared on it, a master), the file still has its `{{placeholders}}` in the Definition editor, and applying a value changes only the other file. The first Setup values edit happened while the agent's machine was struggling.
- **Cause:** before v2.168.0 the first edit seeded the agent's placeholder layer with `cat … || true`, which read a file that could not be read as missing. The layer was stored without that file, and every later edit left it alone.
- **Fix:** upgrade: a file that cannot be read refuses the first edit ("… is there but could not be read. Nothing was changed."), and nothing is stored. On an agent already affected, save the file once in the Definition editor (the saved text becomes its layer), then apply the values again.
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/params'`; `src/orchestrator/snapshots.ts` — `readCoreFile`

### After Push definition, a child's Setup values no longer change its AGENTS.md (or SOUL.md)
- **Check:** the master's setup layer has only one of SOUL.md and AGENTS.md (the other file is not there on the master), the child's file still has its own text, and since the push, applying a value on the child changes only the file the master has.
- **Cause:** before v2.168.0 a push stored the master's layer as the child's whole layer. The file the master has none of was rightly left alone on the child, but its placeholder layer was dropped, so later Setup values had nothing to render it from.
- **Fix:** upgrade: the child keeps its own layer for a file the master does not push. On a child already affected, save that file once in its Definition editor with its `{{placeholders}}` (the saved text becomes its layer), then apply the values again.
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/push-definition'`

### After merging a child's proposal, the master's AGENTS.md holds only that proposal
- **Check:** the master's AGENTS.md is just a `<!-- distilled from <child>, <date> (proposal <id>) -->` block (no `(proposal …)` before v2.178.0) and the lesson under it; its Snapshots have no `pre-edit` from that merge, or one that is missing AGENTS.md. The master's machine was struggling (a runner asleep, Docker slow) at the time.
- **Cause:** before v2.168.0 the merge read AGENTS.md with `head … || true`, so a file that was there but could not be read was taken as empty, and the merge wrote the proposal alone over the playbook.
- **Fix:** upgrade: a read that fails refuses the merge ("Couldn't read the master's playbook: … Nothing was merged; the proposal is still waiting."). On an agent already affected, restore the newest snapshot that has the full AGENTS.md, merge the proposal again, and only then push to the children.
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/proposals/:pid/resolve'`; `src/orchestrator/snapshots.ts` — `readCoreFile`

### After merging a proposal, the master's AGENTS.md cannot be edited, snapshotted, shared or pushed: "over 256KB"
- **Check:** the merge said it worked, and since then the Definition editor, snapshots, Share and Push definition say AGENTS.md is over 256KB; it was just under the limit before the merge.
- **Cause:** before v2.168.0 a merge checked the size of the AGENTS.md it read, not of the file with the proposal added.
- **Fix:** upgrade: a merge whose result (or the master's setup layer with it) would pass the limit is refused, and the proposal stays waiting. For a master already over, trim its AGENTS.md through its chat or console until it is under 256KB.
- **Fixed in:** `v2.168.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/proposals/:pid/resolve'`

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

### A web-chat-only agent says it needs Telegram for a scheduled task, or the task fails with "no configured channels detected"
- **Check:** the agent is in no chat app (no Telegram, Discord or Slack) and runs OpenClaw 2026.9; you asked it in its web chat for something on a schedule ("a market summary every morning"). In the agent's console, `openclaw cron list --json` shows the task it made with `sessionTarget` `isolated` and a `delivery` that names no `channel` or `to`; its runs (`openclaw cron runs --id <id>`) end with "Channel is required (no configured channels detected)". The agent may also say it "isn't the Gateway's default agent", after OpenClaw refused `sessionTarget "main"` for it.
- **Cause:** results of an agent in no chat app go into its web-chat conversation (the one its console opens on), and Hatchabot points tasks with no recipient there. But it did so only a few minutes after a start and then once a day, so a task made in chat in the evening ran the next morning before it was re-pointed; and nothing told the agent that its web chat receives scheduled results, so it fell back on an isolated task and blamed the missing Telegram.
- **Fix:** upgrade, then rebuild the agent (or wait for its next rebuild). Its AGENTS.md gets a "Scheduled results" section saying where results go and how to make such a task (sessionTarget "current", announce with no channel), and Hatchabot checks every running agent's tasks every 5 minutes, re-pointing a new one at the web chat within minutes. A task made before the upgrade is re-pointed on the first check. To fix one by hand: `openclaw cron edit <id> --session current --session-key agent:<slug>:main --announce --best-effort-deliver` in the agent's console.
- **Fixed in:** `v2.163.0`
- **Code:** `src/orchestrator/crons.ts` — `pendingRetarget`, `cronStoreReadShell`, `CRON_QUICK_CHECK_MS`; `src/api/routes.ts` — `quickCronRetarget`; `src/openclaw/workspace.ts` — `scheduledResultsSection`; `src/orchestrator/provision.ts` — `syncDataSourceDocs`

### After removing a chat app, scheduled tasks stop arriving, though their runs show ok
- **Check:** the agent had Telegram, Discord or Slack and you removed it (or removed one of several). The task's line in the Schedule tab shows "not delivered". In the agent's console, `openclaw cron list --json` shows `delivery.channel` still naming the removed app.
- **Cause:** a task made in the app names its channel and recipient, and Hatchabot re-pointed only tasks with no recipient. The task kept aiming at an app the agent no longer has; best-effort delivery counted each run as ok, and the result reached nobody.
- **Fix:** upgrade. Hatchabot checks every running agent's tasks every 5 minutes: one aimed at an app it has left goes to the app that remains, or to the conversation its console opens on if it is in none. If the owner's id on the remaining app is not known yet, the task stays quiet until it is. A task aimed at a route Hatchabot does not manage (WhatsApp, say) is left alone.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/crons.ts` — `retargetImplicitCrons`, `tasksToRetarget`, `retargetCron`; `src/api/routes.ts` — `quickCronRetarget`

### A budget or "Tell me every $X" never fires on an agent using an OpenAI or Google key; it shows $0.00
- **Check:** the agent's AI source is an OpenAI or Google API key (Settings, AI sources). Its row in Budgets read $0.00 this month and $0.00 "a month now", though the key is being billed. Models on the price list (the Model prices drawer) are Anthropic's only.
- **Cause:** Hatchabot has no prices for those models, and the budget's daily figures counted a model with no price as $0, so the limit, the step alarm and the machine's total never saw that spend.
- **Fix:** upgrade: the row says "no price known", and a limit or step on such an agent says it cannot be enforced. There is no dollar figure to enforce, so watch the spend at your provider, and set a limit there. Spend on Anthropic models still counts as before. A model with no known price is left out of the machine's total, which says how many agents that leaves out.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/budgets.ts` — `dailyCosts`, `priceGapNote`, `monthUnpriced`; `src/store/store.ts` — `unpricedBetween`; `web/index.html` — `bgCost`

### No budget, spending or loop message ever arrives, on Discord, Slack or with no chat app
- **Check:** your Hatchabot agent is on Discord or Slack, or in no chat app, and you have no Telegram id linked. You set "Tell me every $X" or a budget; the spend passed it (its tile's tooltip or the Budgets page shows it), and no message came. The Recommended spike item said "not sent".
- **Cause:** these messages went only by Telegram, so an owner elsewhere never heard them, while the page showed the alarm as armed.
- **Fix:** upgrade: they now also go as a direct message from your Hatchabot agent's Discord or Slack bot (or the busy agent's own), once you are linked on it. Discord needs you to share a server with the bot. With no chat at all, Budgets says beside the alarm that no message will come: give your Hatchabot agent a chat app and link yourself, or read the Alerts line and the tile's tooltip.
- **Fixed in:** `v2.173.0`
- **Code:** `src/channels/notify.ts` — `tellOwner`, `ownerChatRoutes`; `src/api/routes.ts` — `tellUsageSpike`, `chatNoteOf`

### Every message fails with "request format rejected, HTTP 400" after a budget moved the agent, or after a source switch
- **Check:** the agent is on a Claude subscription and runs OpenClaw below 2026.9.7 (a pinned runtime image), and its model is now `claude-opus-5-5`. Its timeline shows `budget.downgraded`, or you just switched its AI source with that model pinned.
- **Cause:** Opus 5.5 refuses a Claude subscription through those versions. Choosing that model by hand is refused for this reason, but the budget's cheaper-model step and a source switch did not ask.
- **Fix:** upgrade, then pick a model that answers (or a newer runtime image). The budget now takes the next cheapest model the runtime can use, or says there is nothing cheaper it can run. A source switch drops such a pin and uses the source's default; if that default cannot run either, the switch is refused with the reason (skipped, in a bulk switch).
- **Fixed in:** `v2.173.0`
- **Code:** `src/api/routes.ts` — `subscriptionRuntimeProblem`, `sourceSwitchRuntime`, `switchAgentToSource`; `src/orchestrator/modelOptions.ts` — `SUBSCRIPTION_MIN_OPENCLAW`

### An app still uses the old Telegram bot after the agent's bot changed; Update says "Already running the newest commit"
- **Check:** the app's `hatchabot.json` has a field with `"from": "agent.telegramAccount"` (or `owner.telegram`, and you linked it after installing). Its `config.json` in the agent names the old value, and its messages through that account fail.
- **Cause:** Hatchabot fills those fields only at an install. Changing the bot left the app's copy behind, and Update stopped early when the commit was the same.
- **Fix:** upgrade, then press **Update** on the app. On the same commit it now rewrites the fields that have moved on, runs the app's tests, and says which it changed. A required field with nothing left to fill it is refused with the reason, and the app stays as it was. Nothing prompts you to do this after a bot change.
- **Fixed in:** `v2.173.0`
- **Code:** `src/orchestrator/apps.ts` — `staleFilledFields`, `mergeConfig`

### Google tools stop refreshing after you deleted an old OAuth client secret, though Connections showed a check mark
- **Check:** you saved a new secret for the same client ID in ⚙ Settings → Connections, then deleted the old one at Google. The agents' Google tools fail to refresh, and they have not been started, woken or rebuilt since the save.
- **Cause:** a client secret reaches an agent only when an account is imported into it, and saving a new one imported nothing; the check mark looked only at the token.
- **Fix:** upgrade: saving a new secret now sends it to running agents at once, and marks the others "still has the old client secret" until their next start or rebuild. Keep the old secret at Google until no agent is marked. An agent left broken before the upgrade mends at its next start or rebuild.
- **Fixed in:** `v2.173.0`
- **Code:** `src/api/routes.ts` — `pushClientSecret`; `src/orchestrator/googleConnections.ts` — `materializeConnection`, `syncConnections`; `src/store/store.ts` — `markClientSecretChanged`

### An agent stays marked "still has the old client secret" after you saved a new Google client secret
- **Check:** ⚙ Settings → Connections still marks a running agent after the save, and that agent was busy (a rebuild, a backup, a move) when you saved, or its import of the account failed then.
- **Cause:** the save sent the secret only to the agents running and free at that moment, once. Nothing asked the others again until their next start or rebuild, and saving the same secret again sent nothing.
- **Fix:** upgrade. Every 10 minutes, running agents still owed it are asked again, one account at a time (a restart loses nothing: who is owed is on record). One whose import keeps failing is asked less often, from 10 minutes doubling up to once a day; its Setup log says why. An account it never held before goes into its AGENTS.md too, as after an attach. Saving the client again, changed or not, asks every one at once. A stopped one gets it at its next start. An account made with another client is not marked: only connecting it again mends it. A connection detached or deleted while it was being imported is taken off the agent again. An agent owed several accounts gets them in one go (one exec with a minute for each account, ten at most; each account with its own result, back-off and error, from what gog printed on stderr or else on stdout; an import whose output ends without a newline still counts as done), and its AGENTS.md is written once. A failed account is asked again at the first pass 10 minutes after the one that tried it.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `pushClientSecret`, `deliverClientSecret`, `deliverSecretTo`, `clientSecretSweep`, `'/v1/connections'`; `src/store/store.ts` — `connectionsOwedClientSecret`, `connectionOwedClientSecret`; `src/orchestrator/googleConnections.ts` — `materializeConnections`

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

### A task the agent made in its web chat stops working once the agent joins Telegram: its runs fail, or reach nobody
- **Check:** the task was made by asking the agent in its console or web chat (`openclaw cron list --json` in the agent shows `sessionTarget: "current"` with a `sessionKey` such as `agent:<slug>:web:…`); the agent was then given Telegram and the task's delivery names the owner's chat; its runs fail, or nothing arrives, once that web conversation is gone (deleted, reset, or compacted away).
- **Cause:** pointing the task at the chat changed only its delivery. `cron edit` changes where a task runs only when told to (`--session`, `--clear-session-key`), so the task stayed bound to the web conversation, and a run there fails before the message to Telegram is sent.
- **Fix:** upgrade: a bound task is unbound as it is pointed at the chat (`--session isolated --clear-session-key`; OpenClaw 2026.9.6 and 2026.9.8 both have the flags). A task pointed at the chat before the fix is not looked at again, since its delivery already names the chat: in the agent run `openclaw cron edit <id> --session isolated --clear-session-key`, or delete it and ask the agent for it again.
- **Fixed in:** `v2.166.0`
- **Code:** `src/orchestrator/crons.ts` — `retargetCron`, `deliveryArgs`, `unbind`
### Bring in from OpenClaw: a one-time task (or a daily one) is missing, though the import counted it as carried
- **Check:** the source OpenClaw had a one-time task with the same name as one the agent already has, but for another day (two "Reminder"s), or a recurring task with the same name and schedule but another prompt or time zone. The import's result counted it as carried; the agent's Schedule tab has only the one it had before, and the log says `cron.migrate_already_present` for it.
- **Cause:** a task was taken as "brought over before" by its name and schedule kind alone (and the expression or interval for a recurring one): the one-time task's date, the prompt and the time zone were not compared. The guard against adding a task twice on a second adopt (v2.164.2) took an unrelated task for the earlier copy.
- **Fix:** upgrade, then run the import again: a task differing in its time, prompt or zone is added, and one brought over before is still not added twice. Or add the missing task by hand in the Schedule tab.
- **Fixed in:** `v2.166.0`
- **Code:** `src/orchestrator/cronImport.ts` — `migrateCrons`, `sameTime`

### A reminder (a main-session task) shows no message in the Schedule tab, and editing it fails or turns it into an agent turn
- **Check:** in the agent, `openclaw cron list --json` shows the task with `sessionTarget: "main"` and `payload: { kind: "systemEvent", text: … }`; the Schedule tab shows no message for it, and ✏️ Edit loads an empty Message box.
- **Cause:** the app read a task's words only from `payload.message` (an agent turn's) and `payload.command`, never a system event's `text`; an edit then sent the new words as `--message`, which asks OpenClaw to make the reminder an agent turn, and a main-session task cannot be one.
- **Fix:** upgrade: the reminder's text shows, and an edit sends it as `--system-event`, so it stays a reminder. Meanwhile, edit it in the agent with `openclaw cron edit <id> --system-event "<text>"`.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/crons.ts` — `normalizeCron`, `editCron`

### Clearing a task's Timezone box in the Schedule tab keeps its old zone, or a zone-only change says "Nothing to change."
- **Check:** the task has a zone of its own (`schedule.tz` in `openclaw cron list --json`); you emptied the Timezone box and saved, and the task still runs in the old zone; or a `PATCH …/crons/<id>` with `{"tz": ""}` answered 502 "Nothing to change.".
- **Cause:** a blank zone was dropped as "no change", and `cron edit` cannot remove a zone: it reads `--tz ''` as no zone given, and a new `--cron` keeps the old one.
- **Fix:** upgrade. Emptying the box sets your own zone ("yours if blank", as for a new task); a blank `tz` in the API clears the task's zone, so it runs in the gateway's. The schedule is then sent without a zone through the gateway's `cron.update`.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/crons.ts` — `editCron`; `src/api/routes.ts` — `/v1/agents/:id/crons/:jobId`; `web/index.html` — `addCronJob`

### Bring in from OpenClaw: a task for another recipient is missing, though the import counted it as carried
- **Check:** the source OpenClaw had a task with the same name, schedule and prompt as one the agent already has, but sent to another chat (`delivery.to` in `openclaw cron list --json`); the import counted it as carried, the agent has only the one it had before, and the log says `cron.migrate_already_present` for it.
- **Cause:** a task was taken as "brought over before" without looking at who it goes to (or whether it is a reminder or an agent turn), so the same briefing for two people was one task.
- **Fix:** upgrade, then run the import again: a task naming another recipient is added; one brought over before is still not added twice. Or add it by hand in the Schedule tab.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/cronImport.ts` — `migrateCrons`, `sameRecipient`

### Bring in from OpenClaw: a task the agent made in a conversation came over unbound, or the import counted one as failed (`cron.migrate_unmappable_session`)
- **Check:** in the source, the task has `sessionTarget: "current"` with a `sessionKey` (what an agent makes when asked in a chat or its console); in the adopted agent it has `current` but no `sessionKey`. Or the log says `cron.migrate_unmappable_session` for a task.
- **Cause:** the import carried where the task runs but not the conversation it was bound to, so its result had no conversation to go to.
- **Fix:** upgrade, then run the import again: the task is bound to the same conversation of the adopted agent (`agent:<slug>:…`), which is made if it does not exist yet. A task bound to another agent's conversation is not brought over (counted as failed, logged as `cron.migrate_unmappable_session`): ask the adopted agent for it again.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/cronImport.ts` — `remapSession`, `remapSessionKey`, `cronAddArgs`, `migrateCrons`

### A template's task that was waiting is gone, and the agent has only an older task with the same name
- **Check:** the agent's Schedule tab once showed the template's task as waiting; after a rebuild, start or Try again it is no longer waiting, but the only task of that name is another one (another schedule or prompt), and the log says `schedule.already_present` for it.
- **Cause:** a waiting task was taken as added whenever any task had its name, so it was dropped without being added.
- **Fix:** upgrade: it is taken as added only when the task of that name has its schedule and prompt. Otherwise it stays waiting with "another task already has this name": rename or remove that task, then Try again. A task dropped this way before the upgrade is not waiting any more: add it by hand in the Schedule tab.
- **Fixed in:** `v2.171.0`
- **Code:** `src/orchestrator/provision.ts` — `applyPendingSchedules`, `sameSchedule`

### Turning a task's phone note on or off took although the edit with it was refused
- **Check:** a task's "tell me on my phone" changed, although the edit sent with it was refused (a blank name, a task that no longer exists) or failed.
- **Cause:** the note was saved before the rest of the request was checked or done.
- **Fix:** set the note again. Since the fix, it is saved only once the rest of the request took, and with an edit that took even when turning the task on or off then failed.
- **Fixed in:** `v2.178.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/crons/:jobId'` (PATCH)

### A task made elsewhere that runs more often than every 15 seconds could not be renamed
- **Check:** a scheduled task made by the agent (or with `openclaw cron add`) runs every few seconds. On the Schedule tab, Edit then Save changes says an interval of 0.25 min or more is needed, whatever you changed.
- **Cause:** the page held every save to its 0.25-minute floor, including an interval the task already had.
- **Fix:** ask the agent to change it. Since the fix, a task keeps its own interval through a new name or message while the interval box still shows the number Edit put in it (1.670 for 1.67 is the same). Any other number, an emptied box included, is an interval set on the page and must be 0.25 minutes or more.
- **Fixed in:** `v2.178.0`
- **Code:** `web/index.html` — `editCronJob`, `addCronJob`

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

### At the public address, one visitor's wrong passwords lock everyone out ("Too many failed attempts")
- **Check:** the service log has `public.no_client_address` (from `v2.169.0`): public requests are arriving without `X-Forwarded-For`.
- **Cause:** the public address counts sign-in failures and requests per visitor, by the address in `X-Forwarded-For`, which Tailscale Funnel sets. Something else in front of the public port (another proxy, or a connection straight to it) does not send it, so every visitor is the one visitor "unknown".
- **Fix:** serve the public address through `hatchabot reach on` (Tailscale Funnel) only, or make the proxy in front set `X-Forwarded-For`; wait out the 15-minute lockout.
- **Fixed in:** `v2.169.0` (the log line; the counting is unchanged)
- **Code:** `src/api/trust.ts` — `publicClientAddress`; `src/api/publicAccess.ts` — `public.no_client_address`, `overCeiling`

### At the public address, Download / Import / Share a copy / Upload fails with "second factor required"
- **Check:** the page is opened at the public address, and the toast or upload note says "second factor required" (an HTTP 401 with `secondFactor: "step-up"`).
- **Cause:** these file transfers used plain `fetch()`, which skipped the second-factor prompt that every other action shows.
- **Fix:** upgrade. Until then, do these from the private address, or do any other sensitive action first (it asks for the factor, which then counts for 10 minutes).
- **Fixed in:** `v2.153.0`
- **Code:** `web/index.html` — `sfFetch`, `sfLink`

### At the public address, "Your account has no second factor, so its password cannot be changed at this address"
- **Check:** the page is opened at the public address, the account signs in with a password and has no second factor (Settings → You → Second factor says "You have none"), and Settings → You shows these words where the password form was.
- **Cause:** deliberate since `v2.174.0`. Before it, whoever held only a member's password could change it from the internet, and the real person was locked out until the owner sent a reset link. The new password gave no more access, but the lockout was real.
- **Fix:** change the password at the private address (at home), or ask whoever runs this Hatchabot for a reset link, which works at either address. Adding a second factor at the private address lets you change it at the public one too.
- **Fixed in:** `v2.174.0`
- **Code:** `src/api/publicRoutes.ts` — `PASSWORD_NEEDS_FACTOR`; `src/api/publicAccess.ts` — `noFactor`; `src/api/secondFactor.ts` — `passwordRefused`; `web/index.html` — `loadSecondFactor`

### `hatchabot reach on --invited-only` fails with "unknown option --invited-only"
- **Check:** the command stops before asking anything, with that error.
- **Cause:** the help text documented the flag, but the CLI's list of known flags left it out.
- **Fix:** upgrade. Until then, turn on "only invited people" in the app (Settings → You → Reach it from anywhere), then run `hatchabot reach on`.
- **Fixed in:** `v2.160.0` (#84)
- **Code:** `src/cli.ts` — `parseArgs`

### Turning on public access failed, and `tailscale funnel status` still lists an entry
- **Check:** `tailscale funnel status` lists this Hatchabot's port, while Settings → You → Reach it from anywhere says Off. Nothing answers there: Hatchabot's listener is closed.
- **Cause:** turning on took itself back, but Tailscale refused to remove its entry. The server's warning and the command to remove it were dropped by the page, and so was the same warning from a status read.
- **Fix:** run the command the warning gives: `tailscale funnel --https=<its port> off`, with the port the status shows. Hatchabot tries again each time the page reads the status. Upgrade to see the warning.
- **Fixed in:** `v2.173.0`
- **Code:** `web/index.html` — `reachTurnOn`, `reachRender`; `src/api/reachRoutes.ts` — `funnelLeft`

### At the public address, pictures, sound, video and PDFs in Files showed broken
- **Check:** at the public address, with a second factor on the account, a picture in Files showed broken, or a player or reader stayed empty. Text files worked, and Open in a tab asked for the second factor.
- **Cause:** a file there needs a fresh second factor, and a picture, player or reader cannot ask for one: its request was refused, which broke it.
- **Fix:** press Open in a tab, give the second factor, then go back. Since the fix, a picture, sound or video whose load fails there asks the server whether the file may be read (a check that reads nothing of the file), which asks for the second factor when it has lapsed, and then loads once more. A PDF, and Open in a tab, are checked the same way first, and then the reader or the tab loads it from the server as before. The check asks what a download checks first: a file gone, or one over the size limit (`HATCHABOT_FILE_MAX_MB`), is said there, not shown as an empty reader. Its folder is not read, and the file is not downloaded twice. If it still cannot load, the page says so: open it in a tab or download it.
- **Fixed in:** `v2.178.0`
- **Code:** `web/index.html` — `v2OpenFile`, `sfOpen`; `src/api/routes.ts` — `req.query.check`, `fsReadable`

## The Hatchabot agent

### The Hatchabot agent shows 🔒 "its safety settings were changed (its whole tools block was removed)"
- **Check:** its card or Alerts says so, and its OpenClaw config (`openclaw.json` in its volume) has no `tools` section.
- **Cause:** someone removed the management agent's whole `tools` section, which holds every restriction on what it may run. Before the fix this went unflagged: the config read fell back to OpenClaw's CLI, which fails on a missing section, and a failed read is taken as a passing glitch (HB-0242). Its access to Hatchabot is paused until it is rebuilt.
- **Fix:** Rebuild the Hatchabot agent: the rebuild writes its restrictions back and clears the flag.
- **Fixed in:** `v2.175.0`
- **Code:** `src/ops/opsDrift.ts` — `LOCKDOWN_READ`, `lockdownProblem`, `checkOpsDrift`

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

### The Hatchabot agent's class card named one model (or source, image, memory cap), and the agent got another
- **Check:** the confirmed "🏷 Put … in the class …" card and its ✅ name the class's settings from when the card was made; the agent now runs on different ones, and the class was edited (in another tab, or by someone else) between the card and the Confirm.
- **Cause:** before v2.168.0 the card showed the class's settings but sent only the class's id, so Confirm applied whatever the class said by then.
- **Fix:** upgrade: the card sends the settings it showed, and a class changed since is refused ("The class … changed after this was shown: it now has …. Nothing was changed"); ask the Hatchabot agent again for a card with the class as it is. On an older version, check the class before confirming, or assign it on the agent's page.
- **Fixed in:** `v2.168.0`
- **Code:** `src/mgmt/restTools.ts` — `set_class`; `src/api/routes.ts` — `'/v1/agents/:id/class'`

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

### Asking the Hatchabot agent to switch an agent's AI source by name moved it to a different source of the same name
- **Check:** two of your AI sources (or one of yours and a shared one) have the same name in Settings → AI sources, and the agent's page shows the other one after the confirmed `set_source` card.
- **Cause:** the tool took the first source with that name, and its card showed only the name, so the two could not be told apart.
- **Fix:** upgrade: a name that more than one source has is refused with their ids, and a card for one of them shows its id. Rename one of the sources, or name it by id. Switch the agent back on its page if it moved.
- **Fixed in:** `v2.168.0`
- **Code:** `src/mgmt/restTools.ts` — `pick`, `cardName`, `set_source`, `set_class`

### The Hatchabot agent said ✅ for a model change, but the agent still answers on its old model
- **Check:** the confirmed `set_model` card shows ✅, the agent's page shows the new model as waiting (not yet on the runtime), and its Setup log has `model.live_set_failed`.
- **Cause:** the tool did not read the answer of the model change, which says whether it reached the running agent, was written to a stopped one, waits for a rebuild, or was refused.
- **Fix:** upgrade: a refused change now reads "⚠ Failed — its runtime did not take …", and the others say how it applies. The change is recorded either way: confirm a `rebuild_agent` card, or ask for the model again when the agent answers. Since `v2.178.0` the receipt also says when its class is still applying a change (whether it leaves the class is decided after), and the memory limits its container kept, a refusal included.
- **Fixed in:** `v2.168.0`
- **Code:** `src/mgmt/apiClient.ts` — `setModel`; `src/api/routes.ts` — `'/v1/agents/:id/model'`

### The Hatchabot agent said ✅ for saving a conversation to memory, but nothing was saved
- **Check:** the confirmed `checkpoint_memory` card shows ✅, but the agent's memory files did not change, and its AI source was failing then (out of credits, expired, or unreachable); or an archive through the Hatchabot agent says ✅ while the app showed "Archived, but couldn't save the conversation to memory first".
- **Cause:** the save answers "not saved" (or "could not be checked") as a normal answer, and the tool did not read it, nor an archive's warning.
- **Fix:** upgrade: a save that did not happen reads "⚠ Failed — Couldn't save to memory …", one that cannot be vouched for says so, and an archive passes on its warning. Fix the AI source and save again before a reset or an archive.
- **Fixed in:** `v2.168.0`
- **Code:** `src/mgmt/restTools.ts` — `checkpoint_memory`, `archive_agent`; `src/api/routes.ts` — `'/v1/agents/:id/checkpoint'`

### The Hatchabot agent said ✅ for "try again" on a held move, but the agent is still waiting
- **Check:** a confirmed `recover_operation` card shows ✅ with only the choice it made, while the agent's page (or Alerts) still shows the operation held ("… isn't answering") with its choices.
- **Cause:** the recovery answers with the operation as it is now. The tool only followed one still under way, so a recovery that was held again (the other machine still not answering) or that ended failed was dropped and shown as done.
- **Fix:** upgrade: the card now gives the outcome and, when it is held again, the choices waiting for you; one that failed reads "⚠ Failed — …". Choose again when the other machine answers, or put the agent back where it was.
- **Fixed in:** `v2.168.0`
- **Code:** `src/mgmt/broker.ts` — `followOperation`; `src/mgmt/restTools.ts` — `recover_operation`; `src/api/routes.ts` — `'/v1/operations/:id/recover'`

### A change the Hatchabot agent proposed is gone from Alerts before you answered it
- **Check:** the card was proposed less than a day ago (a card waits that long), more than about fifty other cards were confirmed or cancelled since, and Alerts (or `list_proposals`) no longer shows it; the Hatchabot agent may also have proposed more than its limit of open cards.
- **Cause:** the list held the newest fifty cards of the last day, waiting and answered together, so a busy day's answered cards pushed an older waiting one out, and it no longer counted as open.
- **Fix:** upgrade: every waiting card is listed, and the answered ones are limited on their own. Until then, ask the Hatchabot agent to propose the change again.
- **Fixed in:** `v2.168.0`
- **Code:** `src/store/store.ts` — `listMgmtProposals`; `src/api/mgmtChat.ts` — `'/v1/proposals'`, `OPEN_PROPOSALS_CAP`

### The Hatchabot agent said an agent started, but it was being rebuilt, or the rebuild failed
- **Check:** you confirmed start_agent for a stopped agent that had a change waiting for its start (or needed a rebuild), and it said ✅ at once, while the agent's page showed it rebuilding or failed.
- **Cause:** such a start answers "accepted" and rebuilds in the background; the manager did not follow it, as it does for rebuild_agent.
- **Fix:** upgrade. The manager now follows that rebuild and says how it ended, or why it failed.
- **Fixed in:** `v2.178.0`
- **Code:** `src/mgmt/broker.ts` — `start_agent`, `followOperation`; `src/mgmt/apiClient.ts` — `startAgent`

### The Hatchabot agent said a backup started, but none ran
- **Check:** you confirmed run_backup and it said ✅, but list_backups shows no run and Activity shows the backup failed at once (no backup script, or it could not be started).
- **Cause:** the manager took any answer as started, without reading the run's status.
- **Fix:** upgrade, then look at why it could not start (`hatchabot doctor`). The manager now says "⚠ Failed" with the reason, and for a run under way that list_backups shows when it ends.
- **Fixed in:** `v2.178.0`
- **Code:** `src/mgmt/restTools.ts` — `run_backup`

### A clone made through the Hatchabot agent is missing credentials, data sources or daily notes
- **Check:** you cloned an agent with clone_agent and it said ✅ "Set up and running", but the copy lacks some of the original's Extra credentials, Data sources, or memory files.
- **Cause:** the manager followed the copy's setup and dropped the rest of the answer, which named what was not copied.
- **Fix:** add them to the copy (Data, Advanced → Extra credentials). Since the fix, the manager names each one, as the page does.
- **Fixed in:** `v2.178.0`
- **Code:** `src/mgmt/restTools.ts` — `clone_agent`; `src/mgmt/broker.ts` — `#execMutate`

### The Hatchabot agent prepares a model change that fails on Confirm: "isn't one of this source's models"
- **Check:** the model is not in the agent's AI source's switchable list (Settings → AI sources), though the vendor offers it; or it is in the list but the agent's card was refused with "isn't offered by this agent's source".
- **Cause:** the manager checked the model against the vendor's catalogue, while Confirm checks the source's own list and the agent's runtime.
- **Fix:** upgrade: the manager checks the change as Confirm will, and says the source's models when it is refused. To use a model the vendor offers, add it to the source's switchable list first.
- **Fixed in:** `v2.178.0`
- **Code:** `src/mgmt/broker.ts` — `set_model`; `src/api/routes.ts` — `'/v1/agents/:id/model-check'`, `modelChoiceProblem`

### A set_class card said ✅, but the agent still answers on its old model, or took a swap allowance the card did not show
- **Check:** the class's model is shown as waiting on the agent's page, or its container has the class's swap allowance (`docker inspect -f '{{.HostConfig.MemorySwap}}' <container>`), after a "Put … in the class" card from the Hatchabot agent was confirmed.
- **Cause:** the receipt left out what the class change said had not taken (a model the runtime refused, memory limits the container kept, a rebuild still owed). The card also did not show the class's swap allowance, so a swap allowance changed after the card was shown still applied.
- **Fix:** upgrade: the receipt says what did not take, the card shows the swap allowance, and a class whose swap allowance changed after the card was shown is refused. For an agent on its old model, Rebuild it or put it in the class again.
- **Fixed in:** `v2.178.0`
- **Code:** `src/mgmt/restTools.ts` — `set_class`; `src/api/routes.ts` — `'/v1/agents/:id/class'`

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

### After `enable-compressed-swap.sh --undo`, the machine's own zram swap is gone
- **Check:** `swapon --show` lists no `/dev/zram0`, though the machine had one before Hatchabot's compressed swap was set up (a distribution's zram-generator or zram-tools); `sudo blkid -p /dev/zram0` (once it is back) shows a label other than `hatchabot-zram`.
- **Cause:** before v2.171.0 `--undo` switched off and reset any `/dev/zram0` in use, not only the one its helper made, though zswap had been set up in front of the machine's own. Now it switches off only the one labelled `hatchabot-zram`, or, where the label cannot be read, one in zram mode that was not in use when the script first ran (`PREV_ZRAM0` in `/etc/hatchabot/compressed-swap.state`).
- **Fix:** start the machine's zram again: reboot, or restart its service (`sudo systemctl restart systemd-zram-setup@zram0` for zram-generator, `sudo systemctl restart zramswap` for zram-tools).
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/enable-compressed-swap.sh` — `ours_zram`, `undo`, `PREV_ZRAM0`

### The control plane stops by itself while an agent is stopped, restarting, or on a machine that is down
- **Check:** the service log ends with an uncaught stack overflow; it restarts and runs again.
- **Cause:** a call to a gateway that could not connect closed its socket in a loop until the stack ran out.
- **Fix:** upgrade.
- **Fixed in:** `v2.132.3`
- **Code:** `src/orchestrator/consoleAccess.ts` — `gatewayCallAs`, `settled`

### The service stops and restarts every few seconds while the docker command is missing ("docker unavailable" in its log)
- **Check:** `command -v docker` in the service's environment finds nothing (Docker was removed, or the service's PATH lost it), and the service log ends in an unhandled `docker unavailable: … ENOENT` error.
- **Cause:** the cached container lookup behind the home screen's poll kept a side chain with no failure handler. The poll caught its own error, but the side chain's copy went unhandled, and Node ends the process on that.
- **Fix:** upgrade; the failure is forgotten and reported to the caller only. Then reinstall Docker or put it back on the service's PATH (`hatchabot doctor` says which).
- **Fixed in:** `v2.171.0`
- **Code:** `src/providers/localDockerProvider.ts` — `info`

### The service restarts when an agent's sessions file holds something other than a list ("Cannot use 'in' operator" in its log)
- **Check:** the service log ends in an unhandled `TypeError: Cannot use 'in' operator to search for … in …`, it happens each time the home screen polls, and that agent's `sessions.json` (an agent with no SQLite session store) holds a bare number, string or `true`, not `{…}`.
- **Cause:** the Recent list's capture is started in the background, and it looked a conversation up in whatever the file held. Its failure had no handler, and Node ends the process on that. A few other background chains had the same gap: tidying `.env`, the check after an agent starts, re-checking a manager's doorman, telling members about a rename and clearing a derived image's build folder.
- **Fix:** upgrade; such a file is ignored, the agent's saved previews stay, and the others log the failure or try again next time. Then rebuild or restore that agent if its sessions file is damaged.
- **Fixed in:** `v2.172.0`
- **Code:** `src/orchestrator/recent.ts` — `RecentTracker`; `src/index.ts` — `syncEnvFile`

### The service restarts on a full disk, with "SQLITE_FULL" or "database or disk is full" at the end of its log
- **Check:** `df` shows the disk holding the database full, and the service log ends in an unhandled error from a database call, around an app install that failed or a timer (the paused-agent replies, the cron or manager checks).
- **Cause:** those background jobs read or wrote the database outside their `try`, or in the `catch` that recorded a failure. A database error then had no handler, and Node ends the process on that.
- **Fix:** upgrade, and free some space. Those jobs now log the failure (`app.pending_run_failed`, `cron.sweep_failed`, `ops.drift_check_failed`) and try again next time.
- **Fixed in:** `v2.172.0`
- **Code:** `src/api/routes.ts` — `runPendingApp`, `runPausedReplies`, `retargetCronSweep`, `quickCronRetarget`; `src/ops/opsDrift.ts` — `checkOpsDrift`

### Archive says "Couldn't confirm its runtime stopped" while its machine answers
- **Check:** `docker inspect -f '{{.State.Status}}' <container>` says `paused`.
- **Cause:** a paused container (paused by hand or by another tool) is frozen, not stopped: `docker stop` refuses it, and once unpaused it polls its bot again. Before v2.168.0 it counted as stopped, so an archive gave its bot to the pool while it could still answer.
- **Fix:** `docker unpause <container>`, then archive (or stop) the agent again.
- **Fixed in:** `v2.168.0`
- **Code:** `src/providers/localDockerProvider.ts` — `status`; `src/orchestrator/quiesce.ts` — `stopAndConfirm`

### A multi-line credential (a PEM key, pretty-printed JSON) shows in `ps` while an agent is built
- **Check:** during a build, `ps -ef | grep 'docker create'` shows `-e NAME=` followed by the value of an agent environment setting that spans several lines.
- **Cause:** an env file cannot hold a line break, so such values went on the docker command line, which every user of the machine can read.
- **Fix:** upgrade; such a value now goes as a bare `-e NAME` and the docker client reads it from its own environment. If the machine has other users, rotate a credential that was exposed this way.
- **Fixed in:** `v2.162.0` (#203)
- **Code:** `src/providers/localDockerProvider.ts` — `#withEnvFile`

### After clearing the peaks (or changing a memory cap) and a rebuild, an agent shows no cap hits although it is short of memory
- **Check:** Status → Resources shows 0 cap hits for the agent, while `docker exec <container> cat /sys/fs/cgroup/memory.events` shows a `max` count above 0; the peaks were cleared, or its cap changed, before a rebuild, start or wake.
- **Cause:** clearing kept the old container's count as the starting point, and the new container's count starts again from zero, so its hits were subtracted away until it passed the old one's total. v2.168.0 caught a count below the starting point; a new container that had already passed the old total when it was first read still showed only the hits beyond it.
- **Fix:** upgrade; the starting point remembers when its container started, and a count from a container that started later is shown whole. On older versions, clear the peaks again after the rebuild.
- **Fixed in:** `v2.168.0` (a count below the starting point), `v2.169.0` (any later container, by its start time)
- **Code:** `src/api/routes.ts` — `capHitsSince`, `'/v1/resources'`; `src/store/store.ts` — `rebaseMemoryCapHits`, `clearMemoryPeaks`; `src/providers/localDockerProvider.ts` — `stats`

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

### Adding another server, a move or the bot census fails with "resolves to a local address" or "answered with a redirect"
- **Check:** the server's name resolves to a loopback or link-local address (`getent hosts <name>` on this machine), or its address answers `curl -sI http://<address>/v1/agents` with a 3xx.
- **Cause:** a peer's name was judged only as text, so a name that resolved to this machine's loopback (or a metadata address) was called; later calls followed redirects to any address. Every call to another server now checks the address it actually connects to and refuses redirects.
- **Fix:** register the other server at the address it really answers on (its tailnet or LAN name or IP, with `https://` if it serves HTTPS), not a name that points at this machine or one that redirects. Remove and add the peer again if its address changed.
- **Fixed in:** `v2.162.0` (#200, #201)
- **Code:** `src/api/peerAddress.ts` — `pinnedPeerFetch`, `allowedPeerIp`; `src/orchestrator/migrate.ts` — `peerFetch`

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

### The daily privacy sync fails with "HTTP 403: Resource not accessible by personal access token"
- **Check:** `journalctl --user -u hatchabot-privacy-sync.service` shows `✗ privacy fingerprints: not sent to actions — gh secret set failed (… 403 …)`. The message ends with the token it used. `with gh's own login: there is no …/secrets.token` means the secrets-only token is missing, or was saved somewhere else.
- **Cause:** gh's everyday token cannot write the public repos' secrets. `--sync-ci` uses `~/.config/hatchabot/secrets.token` (or `HATCHABOT_SECRETS_TOKEN_FILE`) and, when that file is not there, falls back to gh's login. A token saved under any other name or folder is not used.
- **Fix:** save the fine-grained token (owner `hatchabot`, only `hatchabot/hatchabot` and `hatchabot/hatchabot.com`, Secrets and Dependabot secrets read and write) as `~/.config/hatchabot/secrets.token`, mode 600. Then run `systemctl --user start hatchabot-privacy-sync.service` and look for two `✓ PRIVACY_FINGERPRINTS set` lines. Until it is fixed, GitHub's privacy checks use the last fingerprints sent, so a value added since then is not covered there.
- **Fixed in:** the release after `v2.164.1` (the failure names the token it used).
- **Code:** `scripts/privacy-check.mjs` (`secretsTokenEnv`, `syncCi`)

## Audit fixes in v2.165.0

### The home screen says "Loading your agents…" for ever in one browser
- **Check:** the same sign-in works in another browser or window; the stuck one is a private window, or has cookies and site data blocked for the site, and the console (F12) shows a `SecurityError` on `localStorage`.
- **Cause:** the page read the remembered sign-in email from browser storage while drawing the home screen, with no guard; a browser that refuses storage threw, and the grid was never drawn.
- **Fix:** upgrade. Every storage read and write is guarded; the page draws without storage (it only forgets per-device conveniences such as the console tabs).
- **Fixed in:** `v2.165.0`
- **Code:** `web/index.html` — `v2RenderWho`, `renderV2`

### Add Telegram answered "Something went wrong" (a 500) on a double click
- **Check:** the agent's timeline shows one `channel.attached`; the second request's reply was a server error; the agent has one bot and works.
- **Cause:** the Telegram attach route ran outside the agent's lifecycle lock; the second click passed the "already has a bot" check and its insert threw as a server error.
- **Fix:** upgrade; nothing to repair. The second attach is refused in words now, as the Discord and Slack attach is.
- **Fixed in:** `v2.165.0`
- **Code:** `src/api/routes.ts` — the `/v1/agents/:id/telegram` route, `whileBusy`

### A new agent fails with "@bot already belongs to …" after a token was pasted for an earlier one
- **Check:** the token pasted for the earlier agent (while it waited for a bot) was a spare bot's, listed under Settings → Messaging → Telegram → Bot pool; that bot now shows in use by the earlier agent, and the later agent failed to start on it.
- **Cause:** the create-flow token paste did not refuse a pool bot's token; the pool row stayed unleased, so the pool leased the same bot to the next agent.
- **Fix:** delete the failed agent (its lease goes back) and make it again; the earlier agent keeps the bot. Since the fix the paste is refused: "a spare bot in the pool".
- **Fixed in:** `v2.165.0`
- **Code:** `src/api/routes.ts` — the `/v1/agents/:id/channel-token` route

### An agent on a runner says it has a folder it cannot see
- **Check:** the agent runs on a runner (its tile says so); Settings → Data lists a folder; Test on it answers "runs on another machine … not mounted there"; the agent answers from nothing when asked about the folder.
- **Cause:** a folder is a bind mount of this machine's disk, which a runner's docker cannot see. The mount was skipped there in silence while the agent's AGENTS.md said it had the data.
- **Fix:** remove the folder from its Data tab (or move the agent to this machine). Since the fix a folder cannot be added to an agent on a runner, and an agent with folders cannot be moved to one (the move says which folders). The older shared-folders setting (`sharedPaths`, set through the API or CLI) still took one until v2.171.0.
- **Fixed in:** `v2.165.0`; `v2.171.0` for `sharedPaths`
- **Code:** `src/api/routes.ts` — `'/v1/agents/:id/data-sources'`, `folders_stay_here`, the `'/v1/agents/:id'` patch route; `src/providers/localDockerProvider.ts` — the `hostMounts` skip for a remote daemon

### A moved or restored agent lost its repos and folders
- **Check:** the agent came from Download copy / Restore or Move to another Hatchabot before v2.165.0; its Data tab is empty; its AGENTS.md says "Data sources: None"; a clone is still on its volume under `~/.openclaw/<repo>` (Files → .openclaw).
- **Cause:** the export carried only the legacy shared folders; the Data tab's repos and folders were not in the file, and the clone's deploy key stayed on the volume untracked.
- **Fix:** add the repo again (Settings → Data → Add a repo; a new deploy key: add it on the git host, press Test, Rebuild) and delete the old key on the git host. Since the fix the file carries repos with their keys and folders as declarations.
- **Fixed in:** `v2.165.0`
- **Code:** `src/orchestrator/transfer.ts` — `ExportedDataSource`, `exportAgent`, `importAgent`; `src/orchestrator/migrate.ts` — the preflight's `sharedPaths`

### After Download copy, the deleted source's bot answered for a new agent here
- **Check:** the agent was downloaded (or moved by file), the copy runs elsewhere, the stopped source was deleted here, and a new agent made here took the same @bot from the pool; messages flip-flop between the two.
- **Cause:** deleting the source parked its bot in this machine's pool by default, as any delete does; the copy was still talking on it.
- **Fix:** on the new agent here, its Telegram tab → Change bot; then remove the parked bot from the pool. Since the fix, deleting a stopped agent whose copy was downloaded leaves the bot alone (`?recycleBot=1` on the delete parks it on purpose).
- **Fixed in:** `v2.165.0`
- **Code:** `src/api/routes.ts` — the `'/v1/agents/:id'` delete route, `bot.not_parked`; `src/store/store.ts` — `setAgentExportedAt`

### A "pause" budget said the agent is paused, Start ran it, and it was stopped again minutes later in silence
- **Check:** the agent was already stopped by hand when the budget reached 100%; the message said "start it in the app (it then runs on until the 1st)"; after Start, the next budget pass stopped it with no message; Settings → Budgets shows no pause for the month before the fix.
- **Cause:** with nothing running to pause, the pass recorded no pause, so Start had nothing to mark as the owner's take-over.
- **Fix:** upgrade, then Start it again (the pass records the pause for a stopped agent now; Start is the take-over). Or raise the budget.
- **Fixed in:** `v2.165.0`
- **Code:** `src/orchestrator/budgets.ts` — `runBudgets` (the stopped-agent branch under `atLimit === 'pause'`)

### A "cheaper model" budget said the agent moved, but it still runs on its own model
- **Check:** the budget message named the cheaper model; the agent's AI tab shows its own model; its timeline has `model.apply_deferred` or a source switch waiting for a rebuild around the time of the message.
- **Cause:** the switch was counted as made when the runtime was busy, mid-move, failed, or waiting for a rebuild after a source switch; nothing reached the runtime.
- **Fix:** upgrade; the next pass switches it (and says so) once the runtime takes it. A rebuild lands the model too.
- **Fixed in:** `v2.165.0`
- **Code:** `src/api/routes.ts` — the budget `downgrade` dependency, `applyModelToRuntime`

### Usage jumped by an agent's whole history after a quiet period
- **Check:** the agent's token chart shows a step the size of its lifetime use; the service log has `usage.sample_partial` for it just before (since the fix), or the agent's transcript database has rows that do not decode.
- **Cause:** a read that skipped rows it could not decode was stored as a counter reading, smaller than the truth; the next whole read counted the skipped rows as fresh use.
- **Fix:** upgrade. A partial read keeps the agent's profile and health but writes no total; the first whole read after it continues from the last good total.
- **Fixed in:** `v2.165.0`
- **Code:** `src/orchestrator/usage.ts` — `partial`; `src/orchestrator/sourceUsage.ts` — `usage.sample_partial`

### An import failed and a volume named after it stays in `docker volume ls` and the backup sets
- **Check:** `docker volume ls` lists `<prefix>-<slug>-<id>-vol` for an agent that is not in the app; the import's operation shows it failed at its first build (seed or image).
- **Cause:** the provider makes the volume before the build can fail, and the rollback destroyed only a runtime whose ref it already knew.
- **Fix:** `docker volume rm <name>` for the leftover. Since the fix the rollback destroys the volume a failed first build made.
- **Fixed in:** `v2.165.0`
- **Code:** `src/orchestrator/transfer.ts` — `rollbackImport`; `src/providers/provider.ts` — `runtimeRefFor`

### Attaching a file in an agent's console fails at once (415)
- **Check:** the browser's network tab shows a `POST …/ui/api/chat/media/outgoing` answered `415 Unsupported Media Type` by Hatchabot (not by the agent's gateway).
- **Cause:** the body was `multipart/form-data`, which Hatchabot's server refused before the console proxy saw it.
- **Fix:** upgrade. The proxy takes any body type; every other route keeps its 415.
- **Fixed in:** `v2.165.0`
- **Code:** `src/api/routes.ts` — the `'*'` content type parser above the `/v1/agents/:id/ui/*` route

### Distill says "The agent produced no usable distillation" though the agent was writing
- **Check:** the agent's gateway log shows a turn of over a minute for the distill prompt that was cut off.
- **Cause:** the distill ran with the 60-second command timeout, while an ask has 280 seconds.
- **Fix:** upgrade and try again; it now has the ask's time and is held like a consult.
- **Fixed in:** `v2.165.0`
- **Code:** `src/api/routes.ts` — the `/v1/agents/:id/distill` route, `ASK_TIMEOUT_MS`

### An agent with a long name on a runner with a long name never starts
- **Check:** the runner's `docker logs` for the container, or the agent's timeline, says the container could not start with an invalid or too-long hostname.
- **Cause:** the container's hostname is `<agent>.<host>`; two long names made it longer than Linux's 64 bytes.
- **Fix:** upgrade and Rebuild (the hostname is cut to 63 bytes, the agent's part first). Or rename the agent shorter.
- **Fixed in:** `v2.165.0`
- **Code:** `src/orchestrator/provision.ts` — `containerHostname`

## Audit fixes in v2.164.2

### A web-chat guest could open owner-only parts of an agent's console (session history, downloads, metrics)
- **Check:** the service log has `console.guest_refused` lines for paths with `\`, `%5c` or a leading `//` after the upgrade; before it, the same requests answered 200. A guest's ordinary chat is unaffected.
- **Cause:** the console proxy judged a guest's path split on `/`, but the agent's gateway reads it with `new URL()`, which takes `\` (or `%5c`) for `/`, drops tabs and newlines, resolves `..`, and reads a leading `//` as a host name. A path like `/assets/x\..\..\sessions/…/history` passed as a static file and reached an operator-only endpoint with the guest's read + write scopes.
- **Fix:** upgrade. The proxy refuses any guest path the gateway would read differently from how it was judged, and forwards only the judged path.
- **Fixed in:** `v2.164.2`
- **Code:** `src/api/consoleProxy.ts` — `guestHttpPath`, `guestHttpAllowed`; `src/api/routes.ts` — the `/v1/agents/:id/ui/*` route

### A stopped agent started by itself after a move was held, and two copies answer its bot
- **Check:** the agent's timeline shows a Rebuild (from Rebuild all, or an AI-source switch with rebuild) that started after "Move to another Hatchabot" or "Move to another machine" was held; Alerts still shows that move waiting for a choice.
- **Cause:** a rebuild that waited its turn in the queue checked for an unfinished operation only when it was queued, not when its turn came, so it started the copy the held move was keeping stopped.
- **Fix:** stop the copy here, then settle the held move from Alerts. Since the fix, a queued rebuild skips itself ("Not rebuilt: … is not over") when its turn comes.
- **Fixed in:** `v2.164.2`
- **Code:** `src/api/routes.ts` — `staleRebuild`, `kickRebuild`

### A move to another Hatchabot was held again after you chose "keep it here", and the running agent refuses Stop and Rebuild
- **Check:** the operation shows rolled back, then held again a few minutes later; two or more moves were held at once while the other server was down.
- **Cause:** the 10-minute retry worked through a list of held moves read before you chose, and put the settled one back on hold.
- **Fix:** choose "It is not on … — keep it here" again. Since the fix, the retry skips an operation that has changed since it was read.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/operationsResume.ts` — `resumeOne`, `retryHeldOperations`

### A scheduled task disappeared when an app was installed, updated or stopped
- **Check:** the missing task's name started with the app's id and a dash (for example `news-digest` with app `news`), or it belonged to another app whose id starts the same way.
- **Cause:** the app treated every job named `<app>-…` as its own and removed it.
- **Fix:** re-create the task in the Tasks page. Since the fix, only the task names the app's manifest makes are treated as its own.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/apps.ts` — `appTaskNames`, `appJobs`, `syncTasks`, `removeTasks`

### A "pause" budget is over 100% but the agent keeps running, and no "paused" message came
- **Check:** the agent's Usage tab → Monthly budget shows more than 100% while its tile is still running; its log shows model calls every few minutes (a scheduled task, a retry loop, a busy chat).
- **Cause:** a pause waited for three minutes without a model call, and an agent in a loop never has three. The wait had no end, so it was never paused, and the 100% message waited for the pause.
- **Fix:** upgrade. A pause now waits at most 20 minutes after the limit is reached, and while it waits you get the 80% message saying it pauses shortly. Before upgrading: press Stop on the agent.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/budgets.ts` — `runBudgets`, `PAUSE_WAIT_MS`

### An agent stays on the cheaper model after the 1st (its budget said "cheaper model")
- **Check:** the agent's model is still the cheap one in the new month, its budget is not over, and the model ledger shows the budget's switch but no switch back. Usually the agent was stopped and started, or archived, while it was switched.
- **Cause:** Start closed the budget's record whatever its kind, and archiving closed it as "gone". Only an open record gets its model put back on the 1st.
- **Fix:** upgrade. Start now leaves a cheaper-model record open, and archiving puts the agent's own model back on its record. An agent already stuck this way is repaired once at the upgrade: while it still runs on the budget's cheaper model, its record is reopened, so its own model comes back on the 1st or as soon as the budget is raised (an archived agent's at once). An agent whose model you changed since is left as it is. Before upgrading: set the model back by hand in the agent's settings.
- **Fixed in:** `v2.164.2`
- **Code:** `src/api/routes.ts` — `/v1/agents/:id/start`; `src/orchestrator/budgets.ts` — `runBudgets`; `src/store/store.ts` — `runOnce`

### Usage → Spend over time → 1 mo: each day's bar holds part of the next day (west of UTC)
- **Check:** spend made in the evening shows under the next day's bar, and a day's bar does not match the budget's figure for that day.
- **Cause:** day (and 3-hour) slices were cut at UTC midnight and labelled in the browser's time.
- **Fix:** upgrade. The page sends its time zone, and slices start at its midnight.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/agentCosts.ts` — `spendSeries`, `zoneOffset`

### Report a problem: a draft shows a short password inside quoted JSON
- **Symptom:** a failure in the draft reads `\"password\":\"…\"`, `{"DB_PASS":"…"}` or `'password' => '…'` with the value still there.
- **Check:** read the draft before sending it. Values of 40 characters or more and known token shapes were always masked. This was short or plain values in these shapes.
- **Cause:** the rules for settings named like a password looked for an unescaped quote or a name right before `=` or `:`, so a field inside a string, a quoted `pass` or `_KEY` name, and a hash's `=>` got past them.
- **Fix:** upgrade, and change any password already in a filed report. These forms are masked now, and failure details in the report go through the same rule. docs/field-reports.md says what can still stay, so read the draft before sending it.
- **Fixed in:** `v2.173.0`
- **Code:** `src/domain/redact.ts` — `redactCredentialFields`; `src/orchestrator/problemReport.ts` — `maskCredentialForms`

### Report a problem: the draft shows the install's own web address or backup folder
- **Check:** the draft's "hatchabot doctor" section has "Public URL https://<your domain>" or "No backup set in /mnt/…".
- **Cause:** the masking knew agent, member and machine names and tailnet addresses, but not `HATCHABOT_PUBLIC_URL`'s domain, the public access address, or a backup folder outside your home folder.
- **Fix:** upgrade; these are now shown as `<host>` and `<path>`. Before upgrading: edit those lines out of the draft before you submit it.
- **Fixed in:** `v2.164.2`
- **Code:** `src/api/routes.ts` — `reportRedaction`; `src/orchestrator/problemReport.ts` — `redactForPublic`

### After Revert on a snapshot, the editor still shows the old text, and Save puts it back
- **Check:** an agent's Personality tab; Revert on a snapshot; the file shown is unchanged, and after Save the revert is gone (the snapshot list has a new "pre-edit" entry holding the reverted text).
- **Cause:** since `v2.156.0` the revert runs in the background and answers before it has written anything; the page read the file straight away and never read it again, so Save wrote the old text back.
- **Fix:** upgrade. Until then, close and reopen the agent after a revert before editing; to undo an accidental Save, revert to the newest "pre-edit" snapshot.
- **Fixed in:** `v2.164.2`
- **Code:** `web/index.html` — `revertSnapshot`, `v2FollowOp`, `v2OpEnded`

### At the public address, a file's ⬇ or its name in Files gives `{"error":"second factor required"}`
- **Check:** the page is opened at the public address, Files was open for more than 10 minutes (`HATCHABOT_PUBLIC_STEPUP_MINUTES`), and the download saves a small JSON file, or the new tab shows that JSON; the folder's ⬇ .tar.gz works.
- **Cause:** the `v2.153.0` fix moved file transfers to `sfFetch`/`sfLink` but missed a single file's ⬇ and the open-in-a-tab link, which stayed plain links that cannot ask for the second factor.
- **Fix:** upgrade. Until then, reopen the Files tab (it asks for the factor, which counts for 10 more minutes), or download from the private address.
- **Fixed in:** `v2.164.2`
- **Code:** `web/index.html` — `sfLink`, `sfOpen`, `v2LoadFiles`

### Settings → Backups: Back up now, Restore drills and Run a drill now fail for a household member
- **Check:** signed in as an account that is not the machine's owner; each button, or changing Restore drills, gives an error toast, the Sets list shows the error, and the drill line says "No restore drill has run yet" even when drills have run.
- **Cause:** the pane showed the owner's controls to every account; the server rightly refuses them to anyone but the owner, and leaves the last drill out of what others read.
- **Fix:** nothing to change: backups and drills are the owner's. Upgrade to see only the per-agent table and a line saying the owner runs them.
- **Fixed in:** `v2.164.2`
- **Code:** `web/index.html` — `loadBackups`

### The `stable` channel (and the image `:stable`) went back to an older release after a promote
- **Check:** `gh api 'repos/hatchabot/hatchabot/commits?path=channels.json' --jq '.[0:3][] | .commit.message'` shows a `Release vX.Y.Z` commit after the `Update channels` one, and `channels.json` on the public main names the older release; the Promote images run for that push says "(a rollback)".
- **Cause:** a release tagged before the promote went out after it, with its own tree and so its own older `channels.json`; promote-images.yml took the change for a rollback and moved `:stable` back.
- **Fix:** upgrade the checkout, then run `scripts/promote.sh <tag> stable` again: it sees the public repo lost the file and asks the publisher once more. Since the fix, promote.sh refuses while such a release is waiting to publish, release.sh refuses to tag a commit whose `channels.json` is behind, and promote-images.yml refuses a backwards move that is not a fast-lane commit. The publisher itself still carries the tag's `channels.json` in a release (a publish-kit bug, reported to the kit).
- **Fixed in:** `v2.164.2`
- **Code:** `scripts/promote.sh` — `pending_gate`, `fast_lane`; `scripts/release-check.sh`; `.github/workflows/promote-images.yml` — `plan`

### `scripts/land.sh` says "Still waiting" though every check passed, and the waiting list names "unreadable"
- **Check:** `gh api repos/cksci/hatchabot-dev/commits/<sha>/status` or `gh api 'repos/cksci/hatchabot-dev/actions/runs?head_sha=<sha>'` fails with the token `land.sh` uses (403, or no network).
- **Cause:** since this fix, a failed read of the Actions runs or the commit statuses counts as a pending check. Before, `land.sh` took it as "nothing there", so a green result from the other source alone could merge the pull request. The dev repo has no branch rules, so `land.sh` is its only gate.
- **Fix:** give the token read access to Actions and Commit statuses (or wait out the GitHub outage), then run `scripts/land.sh` again. A pull request left open merges with `gh pr merge <url> --rebase --delete-branch` once its CI run has passed.
- **Fixed in:** `v2.164.2`
- **Code:** `scripts/land.sh` — `checks`

### A scheduled task never posts, though you have since linked your chat (it was made before)
- **Check:** the task shows as quiet (no delivery) in the agent's Tasks. It was created (from a template, the Tasks page or the manager) before you had messaged the agent's bot, and no `cron.retargeted` event mentions it.
- **Cause:** a task meant to announce, made while there was no one to post to, was made quiet but not remembered as waiting. So the repair pass that points such tasks at you once you are linked never picked it up. The v2.160.0 fix covered only tasks that a repair pass had quieted itself.
- **Fix:** upgrade. Tasks made after the upgrade are remembered and point at you once you have messaged the bot. For a task that is already quiet, edit it in Tasks and turn announcing on.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/crons.ts` — `addCron`; `src/store/store.ts` — `addQuietedCron`

### Adopting an agent from OpenClaw 2026.9 brought none of its scheduled tasks
- **Check:** the adopt message says nothing about tasks (or "0 carried") although the OpenClaw agent had some, and the source install is OpenClaw 2026.9 or later.
- **Cause:** adopt read only the older task store, with one column per field. 2026.9 keeps one `job_json` per task, so the read failed, and the failure was taken as "no tasks".
- **Fix:** upgrade and adopt again; the copy's tasks come in disabled, for you to review. Since the fix, the adopt message says when it can't read a task store.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/cronImport.ts` — `readOpenclawCronStore`, `migrateCrons`

### Adopted reminders (main-session tasks) were not carried, or came in as agent turns
- **Check:** the source agent had reminders that run in its main conversation. After adopt they are missing from Tasks, or they run as a separate agent turn.
- **Cause:** adopt wrote every non-command task as `--message` (an agent turn). OpenClaw refuses that for a main-session job, which needs `--system-event`.
- **Fix:** upgrade and adopt again.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/cronImport.ts` — `cronAddArgs`

### A budget said it moved an agent to a cheaper model, but it kept spending on its own
- **Check:** the agent's budget is set to "cheaper model" and is over 100%. Its timeline has `model.live_set_failed` around the time the budget was reached, and Usage still shows the expensive model.
- **Cause:** when the runtime refused the switch (`openclaw models set` failed, for example while the gateway restarted), Hatchabot still counted it as made, so it never tried again.
- **Fix:** upgrade. A refused switch is now undone and tried again on the next usage pass. Meanwhile you get the 80% message saying it moves to a cheaper model shortly. If the switch still hasn't worked 20 minutes after the limit, the 100% message says it did not take and that the agent still runs on its own model; after that it is tried hourly, and once it takes you get one more message saying it now runs on the cheaper model. The refusal goes on the agent's timeline once a day. Before upgrading, set the cheaper model by hand in the agent's settings.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/budgets.ts` — `runBudgets`

### Usage shows "no price known" for a model Hatchabot prices
- **Check:** the model name has its vendor in front (`anthropic/claude-opus-4-8`) or a date after it (`claude-opus-4-8-20261001`), and the bare name is listed in Settings → AI sources → Model prices.
- **Cause:** the cost estimate looked up the name exactly as written, so those spellings had no price.
- **Fix:** upgrade. Every spelling of a known model now gets the same price.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/pricing.ts` — `priceOf`, `estimateCost`

### Unread dots and the home screen's recent lines stopped changing after an OpenClaw upgrade
- **Check:** the agent was made on OpenClaw 2026.7 and now runs 2026.8 or later. Its volume still has `agents/<slug>/sessions/sessions.json` next to `agent/openclaw-agent.sqlite`, and its chat shows newer messages than the recent line does.
- **Cause:** the unread and recent readers read the old `sessions.json` before the SQLite store, so they kept showing what was there at the upgrade.
- **Fix:** upgrade. Both now read the SQLite store first, as the chat does.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/unread.ts` — `sessionsReadShell`; `src/orchestrator/recent.ts`

### Sharing a folder that holds a custom backup folder was allowed
- **Check:** `HATCHABOT_BACKUP_DIR` is set (to a NAS, for example), and an agent's Data or Shared folders list that folder or one above it.
- **Cause:** the share check refused only the default backup folder. A backup set holds the database and `secret-key.env`, which together unlock every credential in the install.
- **Fix:** upgrade. Such a share is now refused, and an existing one fails at the agent's next rebuild with "A shared folder is no longer safe to mount". Remove it from the agent's Data, then rebuild.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/provision.ts` — `sharePathProblem`

### A cloned agent runs on a different AI source (or machine) from the original
- **Check:** the clone's Settings show the household's default AI source while the original uses another one, or the clone is on this machine while the original is on a runner.
- **Cause:** Clone never passed the original's AI source and machine, so the copy took the defaults.
- **Fix:** upgrade. A clone now keeps both whenever you are allowed to use them. For an existing clone, switch its AI source in its settings.
- **Fixed in:** `v2.164.2`
- **Code:** `src/api/routes.ts` — `/v1/agents/:id/clone`

### An agent's timeline is full of "guest refused" lines with odd method names
- **Check:** the agent's timeline has many `console.guest_refused` entries from one guest, each naming a different method, and older setup lines are gone.
- **Cause:** each refused method name was recorded once a day, and the guest chooses the names, so made-up names could push the 200-line history out.
- **Fix:** upgrade. Each guest now gets ten names a day per agent, and anything past that is one "(other methods)" line. If someone is doing this on purpose, take away that person's web chat.
- **Fixed in:** `v2.164.2`
- **Code:** `src/api/guestConsoleLog.ts` — `GuestConsoleLog`, `refusal`

### Verify access shows a removed person as gone, but they still talk to the agent in a Slack channel or Discord server
- **Check:** the person was removed and Access → Verify lists nobody for that chat app, yet the agent still answers them in a channel or server.
- **Cause:** the check read the DM lists and the pairing store, but not the channel and server `users` lists that Hatchabot also writes.
- **Fix:** upgrade, then run Verify again. Anyone left in a room's list now shows up, and removing them again clears it. A rebuild rewrites the room lists from the member list.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/accessOverview.ts` — `accessProbeScript`

### Health says healthy while the agent's Discord or Slack bot is offline
- **Check:** the bot shows as offline in Discord or Slack, but Check health says Responding.
- **Cause:** health checked only Telegram's connection.
- **Fix:** upgrade. A Discord or Slack bot that reports it is not connected now makes health degraded, with a "Discord connected — disconnected" row. Check the bot's token, then rebuild.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/health.ts` — `agentHealth`

### Agents lost their swap allowance after an upgrade: "zswap's shrinker is on"
- **Check:** the agent's sheet or `hatchabot doctor` says "zswap's shrinker is on: it writes agents' cold memory on to … early", and `cat /sys/module/zswap/parameters/shrinker_enabled` prints `Y`.
- **Cause:** with the shrinker on, zswap writes cold compressed pages, such as an idle agent's memory with its keys, to the disk swap early. That makes it disk swap with a delay. Hatchabot used to count any zswap in front of a swap device as compressed swap.
- **Fix:** run `sudo scripts/enable-compressed-swap.sh`, which turns the shrinker off now and at every boot. Agents get their allowance back within ten minutes. For nothing on disk at all, use `--zram`.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/swap.ts` — `parseSwapProbe`, `SWAP_PROBE_SCRIPT`; `scripts/enable-compressed-swap.sh`

### Install image on a runner: two copies run at once, or a failed copy leaves `docker save` running
- **Check:** after you click Install image twice (or from two tabs), the runner receives the image twice. Or `ps` on this machine shows a `docker save` long after an image copy failed.
- **Cause:** the route checked for a copy under way only after two awaits, so two requests could each start one. And a `docker load` that failed early left `docker save` stuck writing to its pipe.
- **Fix:** upgrade. Until then, click once. `pkill -f 'docker save'` (or restarting the service) clears a stuck copy.
- **Fixed in:** `v2.164.2`
- **Code:** `src/api/routes.ts` — `/v1/hosts/:id/install-image`; `src/orchestrator/runnerSetup.ts` — `installRuntimeImage`

### "DuckDuckGo turns this machine away" or "Agents have no working web search" (was: DuckDuckGo "answered with no results")
- **Check:** Settings → AI → Fleet search key → **Test search** shows the line. From the machine, `curl -s -o /dev/null -w '%{http_code}\n' -A 'Mozilla/5.0 (Hatchabot)' 'https://html.duckduckgo.com/html/?q=weather%20forecast'` prints `202`, and the page it sends asks you to "complete the following challenge". The manager's web search says the same instead of "No results."
- **Cause:** DuckDuckGo answers some machines' addresses with a challenge page meant for a person, not search results. Hatchabot does not pose as a browser to get past it, because that would be working around DuckDuckGo's own block. So this machine has no free search, and agents with no working Brave key cannot search. Before `v2.174.0` the page said only that DuckDuckGo "answered with no results", and the manager said "No results."
- **Fix:** paste a Brave Search API key under Settings → AI → Fleet search key, with quota left. If one is set and has run out or been refused, the message says so: replace it, or wait for its quota. If it works but **Use** says "DuckDuckGo only", choose "Brave, and DuckDuckGo when it runs out". While DuckDuckGo turns the machine away (or does not answer with results), agents stay on a Brave key that is nearly out, and move off it only once it has run out or is refused; the page warns that there is then nothing to fall back on. Being turned away is said once, and again only after DuckDuckGo has worked at two checks running. The block can lift later: **Test search** checks again.
- **Fixed in:** `v2.174.0` (the plain message; the block is DuckDuckGo's)
- **Code:** `src/orchestrator/webSearch.ts` — `probeDuckDuckGo`, `duckDuckGoTurnedAway`, `DDG_TURNED_AWAY`, `braveAdvice`, `createSearchWatch`; `src/ops/opsWeb.ts` — `makeOpsWeb`; `web/index.html` — `renderSearchHealth`

### "The Brave key has 0 queries left", though the key works and Brave's dashboard shows nothing wrong
- **Check:** Settings → AI → Fleet search key says this and the fleet is on DuckDuckGo, and the Brave key is on a metered (credit) plan, so its monthly limit is reported as 0.
- **Cause:** before v2.172.2, Brave's "0 = no monthly cap" was read as an empty key. Hatchabot moved agents to DuckDuckGo and kept them there, since every check got the same answer. If DuckDuckGo turns this machine's address away too, agents have no working search.
- **Fix:** upgrade, then press **Test search** to move the fleet back to Brave at once. Otherwise it goes back at the next check, within a day. There is no way to force Brave on an older version.
- **Fixed in:** `v2.172.2`
- **Code:** `src/orchestrator/webSearch.ts` — `probeBrave`

### Brave searches this month shows fewer searches, or a different cost, than Brave's dashboard
- **Check:** Settings → AI → Fleet search key → **Brave searches this month**, against Brave's dashboard for the same days. The panel's month is the UTC calendar month, or, on a plan with a monthly cap, the month that ends at the reset Brave gave the last check.
- **Cause:** the panel counts what Hatchabot sees: each agent's searches as its transcripts record them (read about once an hour, so the last hour may be missing), the Hatchabot agent's own and Hatchabot's checks. It cannot see searches made with the same key outside Hatchabot, and an agent stopped since its last read adds its searches only once it runs again. The cost is an estimate from the price set under **Price**, less the monthly credit; Brave bills by its own account and month.
- **Fix:** nothing is wrong when the gap is searches made elsewhere or the last hour. Set **Price** to your plan's numbers. A key used outside Hatchabot is better replaced by one of its own, so the quota and the panel agree.
- **Fixed in:** `v2.176.0` (the panel is new)
- **Code:** `src/orchestrator/searchUsage.ts` — `searchUsageReport`, `searchPeriod`, `readSearchPrice`; `src/orchestrator/usage.ts` — `USAGE_READER_SCRIPT`; `src/orchestrator/sourceUsage.ts` — `sampleAgentUsage`; `web/index.html` — `searchUsageHTML`

### An agent says Brave's quota is used up, or web search does not work
- **Check:** Settings → AI → Fleet search key → **Test search** says what Brave and DuckDuckGo answer from this machine, and which is in use. An agent's **Test web search** (Advanced tab) runs a real search in it and names who answered.
- **Cause:** OpenClaw falls back only to providers that hold a key, so never to DuckDuckGo, and it auto-detects only those too, so an agent with no key had no search unless one was named. An empty Brave key failed every agent's search until someone changed it.
- **Fix:** upgrade. Agents now move to DuckDuckGo with no rebuild when the fleet key runs out, and back when its quota returns; Hatchabot messages you. It checks every 6 hours, hourly near the limit, so **Test search** moves them at once if you see this first. An agent with a search key of its own (such as `BRAVE_API_KEY` in its Environment) is not moved: replace that key or remove it and rebuild. A fleet key you replace reaches agents at their next rebuild, and they use DuckDuckGo until then, even if the old key still works; Settings says how many. An agent with no key gets DuckDuckGo at its next rebuild, or within minutes while it runs. A provider other than DuckDuckGo set by hand in `tools.web.search.provider` is left alone. If both fail from this machine, DuckDuckGo may be turning its address away for now.
- **Fixed in:** `v2.172.0`
- **Code:** `src/orchestrator/webSearch.ts` — `createSearchWatch`, `probeBrave`, `applySearchScript`; `src/openclaw/configWriter.ts` — `buildConfigCommands`; `src/ops/opsWeb.ts` — `makeOpsWeb`

### The manager's web search shows titles and links but no descriptions
- **Check:** no Brave key is set, so `web_search` uses DuckDuckGo, and every result's third line is empty.
- **Cause:** the DuckDuckGo parser's lazy match ended right after each link, so the optional snippet never matched.
- **Fix:** upgrade, or add a Brave Search key.
- **Fixed in:** `v2.164.2`
- **Code:** `src/ops/opsWeb.ts` — `makeOpsWeb`

### Agents keep the machine's time zone although HATCHABOT_TIMEZONE names one like EST5EDT
- **Check:** `.env` has `HATCHABOT_TIMEZONE=` set to a zone whose first part has digits (`EST5EDT`, `CST6CDT`, `PST8PDT`); agents' times follow the machine's zone instead.
- **Cause:** a check run before the runtime's own list allowed letters only in the first part of the name, so these zones counted as unknown and the machine's zone was used.
- **Fix:** upgrade and rebuild the agents. Meanwhile, use the region name (`America/New_York`).
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/timezone.ts` — `validTimeZone`

### The installer's "Open Hatchabot" link reads http://…:"8123" and does not open
- **Check:** `.env` has the port in quotes (`PORT="8123"` or `PORT='8123'`) or with a comment after it; the link (and `hbt` without `--url`) uses the port with its quotes.
- **Cause:** `first-run-link.sh` and `setup-host.sh` took everything after `PORT=` as the port, quotes and comment included. The service itself reads the quoted value fine.
- **Fix:** open `http://<this machine>:8123` by hand, or write the line as `PORT=8123`. Since the fix, both scripts drop the quotes and a trailing comment, as `deploy-release.sh` does.
- **Fixed in:** `v2.164.2`
- **Code:** `scripts/first-run-link.sh`, `scripts/setup-host.sh`

### The installer's "Open Hatchabot" link is http:// with no setup code, though Hatchabot serves HTTPS itself or listens on one address
- **Check:** `.env` sets `HATCHABOT_TLS_CERT`, or `HATCHABOT_BIND` to one address; the installer said "did not answer on port … yet", or printed a link without `#setup=`; `https://<bind address>:<PORT>` opens.
- **Cause:** `first-run-link.sh` always asked `http://127.0.0.1` and printed `http://` links, so it never reached a native-TLS listener or one bound to a LAN address, and could not tell that the first account needed its setup code.
- **Fix:** open `https://<this machine or bind address>:<PORT>` by hand; the setup code is in `journalctl --user -u hatchabot | grep 'first-run setup code'`. Since the fix, the link asks the listener as `restart.sh` does: https when it serves TLS, at the bind address when it is one host, and a loopback-only listener gets no LAN link.
- **Fixed in:** `v2.171.0`
- **Code:** `scripts/first-run-link.sh` — `envval`, `PROBE_HOST`

### The service log says ".env … would be read in another order — left as it was" or "has a value on more than one line"
- **Check:** `journalctl --user -u hatchabot | grep -i 'left as it was'`; the `.env` has a value with `$` outside single quotes (`PORT=$MY_PORT`), or an `export NAME="…` value that runs over several lines.
- **Cause:** the start-up tidy reorders lines. With a `$` in force, a shell that sources the file (the macOS launcher) reads another value once the lines move; an exported value over several lines was read line by line, as if its lines were settings of their own. Before the fix the tidy went ahead and changed the value.
- **Fix:** nothing breaks: the file is left as written and Hatchabot runs on it. To let the tidy run again, write each value out in full (KEY=VALUE on one line, no `$VAR`; the file's header says so). If a value already changed on an older version, put it back by hand.
- **Fixed in:** `v2.164.2`
- **Code:** `src/config/envFile.ts` — `syncEnvText`, `multilineSetting`

### A file whose name ends in ".constructor" (or another of JavaScript's own names) fails to open in Files
- **Check:** opening the file in the browser from Files gives an error; other files open.
- **Cause:** the table of file types was looked up with inherited names too, so `.constructor` gave a function instead of a type.
- **Fix:** upgrade, or download the file instead of opening it.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/agentFiles.ts` — `inlineType`

### Health says "Config warnings: 20 findings" and lists only notes, though the check failed
- **Check:** Check health on the agent: `ok` is false and the warnings listed are all minor; `openclaw doctor --lint` in the agent lists more than 20 findings, an error among the later ones.
- **Cause:** only the first 20 findings were kept, in doctor's own order, so an error after 20 notes was dropped from the list and the count.
- **Fix:** upgrade. Errors are listed first, then warnings; the count is all of them, and "… and N more" says what isn't listed.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/health.ts` — `doctorLint`; `web/index.html` — `v2HealthProblems`

### A digit or # keycap emoji (1️⃣, #️⃣) is refused as an agent's icon
- **Check:** setting the icon to a keycap does nothing, or the API answers that the icon is not one emoji.
- **Cause:** the icon check refused anything with an ASCII character, and a keycap starts with one (`1` + U+FE0F + U+20E3).
- **Fix:** upgrade.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/agentIcons.ts` — `validIcon`

### A problem report draft shows a private address written in hex after ::ffff:
- **Check:** the draft from Report a problem has `::ffff:` followed by two hex groups (not a dotted address).
- **Cause:** a private IPv4 address mapped into IPv6 was masked only in its dotted form (`::ffff:` and four numbers), not in hex (`::ffff:` and two hex groups).
- **Fix:** delete the address from the draft before sending (you review every line). Since the fix it is masked as `<private-ip>`.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/problemReport.ts` — `redactForPublic`

### An upload with a very long file name fails, or leaves a `.part` file in the folder
- **Check:** the file's name is longer than about 230 bytes (a non-Latin name reaches that sooner; each character can be 2–4 bytes), and the upload failed with a "File name too long" error. Or the folder in Files holds a `<name>.part-…` file after an upload that failed partway (a full disk, the agent stopped meanwhile).
- **Cause:** the file was written beside its target as the target's name plus a `.part-…` suffix, which made a 255-byte name too long to write. A write that failed left that file behind.
- **Fix:** upgrade, then upload again. Delete a leftover `.part-…` file in Files. Since the fix, the file is written under a short name of its own (`.hatchabot-upload-….part`, hidden), which is removed when the write fails.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/agentFiles.ts` — `putArgv`

### An upload replaced a file that appeared while it was being sent, though "overwrite" was not asked for
- **Check:** the agent (or another upload) wrote a file under the same name in the seconds the upload was streaming; the file now holds the upload, and no "already exists" message came.
- **Cause:** the name was checked before the bytes streamed and the finished file was moved into place with `mv -f`, which replaced whatever had appeared meanwhile.
- **Fix:** restore the file from a backup or a snapshot if it mattered. Since the fix, an upload without overwrite goes into place with `ln -T`, which refuses a name that appeared meanwhile and answers "already exists".
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/agentFiles.ts` — `putArgv`

### After an adopt, the agent's notes and tasks still name the old folder (`/home/…/workspace`)
- **Check:** the adopted agent's files or scheduled tasks mention the hand-built install's absolute workspace path, not `/home/node/.openclaw/agents/<slug>/agent`; the old install's `openclaw.json` gives that workspace as `~/…`.
- **Cause:** the adopt rewrote only the path as `openclaw.json` wrote it (`~/workspace`), not its absolute form (`/home/you/workspace`), which is how the notes and tasks usually name it.
- **Fix:** adopt again after upgrading, or edit the paths by hand (Files, Tasks). Since the fix, both forms are rewritten.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/cronImport.ts` — `selfPathReplacements`

### An adopt rewrote a path to another folder whose name only starts the same (`/data/work+archive`)
- **Check:** after an adopt, a path such as `/data/work+archive/…`, `/data/work@old` or `/data/work=2` in the agent's files or tasks now starts with `/home/node/.openclaw/agents/<slug>/agent`, but that folder was never the workspace.
- **Cause:** the rewrite took `+`, `@`, `%` and `=` as the end of a path, so a sibling folder whose name went on with one of them was rewritten as if it were the workspace.
- **Fix:** put the path back by hand (Files, Tasks). Since the fix, those characters count as part of a name.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/cronImport.ts` — `pathPattern`

### After adopting a workspace whose path has an apostrophe, none of its paths were rewritten
- **Check:** the old workspace's path has a `'` in it (`/data/owner's workspace`); the adopted agent's files still name it; the agent's log has `adopt.path_rewrite_skipped` with `reason: quote in path`.
- **Cause:** the rewrite runs a shell command in the agent's container, and a path with a single quote was skipped rather than quoted, with no word to the owner.
- **Fix:** adopt again after upgrading, or edit the paths by hand. Since the fix, the paths are quoted for the shell and rewritten.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/cronImport.ts` — `rewriteWorkspaceFiles`

### The exported chat history is missing a conversation, with no word why
- **Check:** an older conversation you remember is not in the file from Download chat history; the agent runs OpenClaw 2026.9 (its history is in `openclaw-agent.sqlite`).
- **Cause:** a damaged record in the agent's database (a compressed message or a whole archived conversation that would not decompress) was dropped in silence.
- **Fix:** upgrade and export again: the file now begins with "⚠ N saved records could not be read … and are left out", and the download carries an `x-hatchabot-unreadable` header. What is damaged cannot be read back; a snapshot from before the damage may still have it.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/transcript.ts` — `RENDER_SCRIPT`, `exportTranscript`

### A workspace adopted into a stopped agent said its tasks were "deferred", and they never came
- **Check:** the adopt's answer had `crons.deferred` (adopted with the API or CLI into a stopped agent, or while the agent was busy: `adopt.repoint_busy` in its log); the agent has none of the old install's scheduled tasks, and its files still name the old paths.
- **Cause:** nothing kept the deferred work: the paths and tasks were re-pointed only during the adopt itself, and only when the agent was running and free.
- **Fix:** upgrade, then start the agent: within 5 minutes the adopt finishes (`adopt.deferred_done` on its timeline), with the tasks carried disabled. If its gateway does not answer yet, it is looked at again within the hour (`adopt.deferred_waiting`), for up to a day of the agent running; tasks that still could not be brought over are told to you (`adopt.deferred_failed`): add them in its Tasks page. An adopt from before the upgrade was not remembered; adopt it again.
- **Fixed in:** `v2.164.2`
- **Code:** `src/api/routes.ts` — `repointAdopted`, `finishDeferredAdopts`; `src/store/store.ts` — `setAdoptPending`, `listAdoptPending`

### A clone is missing notes from deep folders under memory/
- **Check:** the source agent keeps notes four or more folders deep (`memory/projects/2026/q3/note.md`); the clone has none of them, and its list of files not copied doesn't name them either.
- **Cause:** a clone read memory/ only three folders deep and left out what was below without saying so.
- **Fix:** upgrade and clone again, or copy those notes by hand. Since the fix, a clone reads eight folders deep, and lists a folder deeper than that among the files not copied.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/template.ts` — `readCloneMemory`

### An adopt fails: "… changed while it was being copied (a link or folder in its place)"
- **Check:** the old install was running while you adopted, and something in the workspace was replaced by a link (or a folder by a link) between the look and the copy.
- **Cause:** this is the guard working. The copy carries only the plain files the look found; one that became a link went in as the link, and a folder that became a link carried a file from outside the workspace under a listed name.
- **Fix:** stop the old install (or wait for it to settle), look at the folder again, and adopt it again. Nothing was copied.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/adopt.ts` — `packWorkspace`

### A derived image was refused with "The heredoc <<EOF is never closed" for a line that only prints `<<EOF` in quotes
- **Check:** the refused lines have `<<` inside quotes on a line that starts an instruction, for example `RUN echo "use <<EOF to start"`.
- **Cause:** the image check read every `<<` as the start of a heredoc, quoted or not. BuildKit reads a quoted one as text.
- **Fix:** upgrade, or move the text out of the RUN line (into a file the image copies). Since the fix, a `<<` inside quotes on a line that starts an instruction is text. On a line that continues another one (a `\` before it), every `<<` still counts, because that line may begin inside a quote.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/derivedImage.ts` — `dockerfileProblem`, `quotedSpans`

### Importing a template failed with an error about `trim`, or put odd text in the copy's SOUL.md
- **Check:** the template has a setup field whose key is a built-in name such as `constructor` or `toString`, and the importer left it empty.
- **Cause:** an empty answer was looked up on the answers object and found JavaScript's own function of that name, which a yes/no field then tried to `trim`, and a text field wrote into the files.
- **Fix:** upgrade, or give that field an answer. Since the fix, only an answer actually given counts; otherwise the field's default does.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/template.ts` — `resolveParamValues`

### A required setup field accepted an answer of only spaces
- **Check:** a copy made from a template has a blank where the required answer should be in SOUL.md or AGENTS.md.
- **Cause:** the required-field check refused an empty answer but not one of spaces.
- **Fix:** fill the value in the copy's Setup values. Since the fix, an answer of only spaces counts as blank for a required field.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/template.ts` — `resolveParamValues`

### A copy from a template ran a shortened scheduled task
- **Check:** the original task's message is longer than 4,000 characters (the app caps the tasks it makes at that; ones the agent made, or adopted from another install, can be longer). In the copy, the same task's message stops part way.
- **Cause:** the export cut each task's message to the 4,000 characters a template carries, without saying so.
- **Fix:** shorten the task (or switch it off) and export again. Since the fix, the export is refused and names the tasks that are too long.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/template.ts` — `exportTemplate`, `MAX_TEMPLATE_TASK_MESSAGE`

### The template's personal-data warning missed an address in a task name or a setup field's label or options
- **Check:** the template file has an email address or phone number in `schedules[].name`, `parameters[].label` or `parameters[].options`, and the export said it found none.
- **Cause:** the scan read the task messages, the files and the setup fields' help and defaults, but not those three.
- **Fix:** read the template before you send it, and rename the task or field. Since the fix, the scan reads them too.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/template.ts` — `scanTemplate`

### An app's settings file lost a required value, or kept a blank one the app now requires
- **Check:** the app's manifest has a required field keyed like a built-in name (`constructor`), which install never asked for and the config file doesn't have. Or a field that was optional is now required, and its config value is still `""`.
- **Cause:** a key named like a built-in was found on JavaScript's object, not in the file, so it counted as set. A value kept from before was never checked against the field's new rules.
- **Fix:** upgrade, then Update the app; it asks for the value. Since the fix, only the file's own values count, and a required field with a blank value is asked for again (or takes its default).
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/apps.ts` — `mergeConfig`

### An app's config file got a default of the wrong type, such as text for a number
- **Check:** the app's `hatchabot.json` gives a field of type `number`, `bool`, `list` or `email` a `default` that is not of that type, and the config file has it as written.
- **Cause:** values given were held to their field's type, but defaults were written as they were.
- **Fix:** the app's author fixes the default. Since the fix, a default is converted like a value given (`"5"` is written as 5). One that can't be converted stops the install with "the app's default for … is not …"; give the value yourself to go on.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/apps.ts` — `mergeConfig`

### Changing an app's settings on the same release left a failed test's changes in the running app
- **Check:** you changed an app's settings without changing its release, its tests failed, and the page said nothing had changed. But files in the app's live release folder are different from before.
- **Cause:** for a settings-only change, the tests ran in the live release folder, so whatever they wrote there stayed.
- **Fix:** Update the app (or reinstall the release) to put its code back. Since the fix, those tests run in a copy of the live folder (built files and all) that is removed afterwards.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/apps.ts` — `installRelease`, `clearStaging`

### Update app says `No commit "HEAD" in the repo` after the repo's main branch was renamed
- **Check:** the app's git repo renamed its default branch (for example `main` to `trunk`) after the app was installed.
- **Cause:** Hatchabot's copy of the repo fetched the branches but kept pointing at the old default branch, which the fetch removed.
- **Fix:** upgrade, then Update again. Before it, install the app again from the new branch's name.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/apps.ts` — `repoFor`

### A master's push left its children asking for setup fields the master no longer has
- **Check:** the master's Setup fields were all removed, then its definition was pushed; each child's Setup values still lists the old fields.
- **Cause:** the push copied the master's fields only when it had some, and no fields are stored the same as never declared, so "none now" never reached the children.
- **Fix:** push again after upgrading. Since the fix, a push gives each child the master's fields plus any `{{placeholder}}` the pushed text still uses, as derive does. The child keeps its own wording for one it already had.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/template.ts` — `pushedParameters`; `src/api/routes.ts` — the `/v1/agents/:id/push-definition` route

### A failed push left a child with the master's new SOUL.md and its old AGENTS.md
- **Check:** the push result names the child with "write failed", and the child's SOUL.md is the new text while AGENTS.md is the old.
- **Cause:** the push wrote the two files one after the other, and nothing undid the first when the second failed.
- **Fix:** push again, or restore the child's `pre-params` snapshot. Since the fix, a failed push puts back what it wrote. If that fails too, the result says to restore the snapshot.
- **Fixed in:** `v2.164.2`
- **Code:** `src/api/routes.ts` — the `/v1/agents/:id/push-definition` route

(B29/B30, the waiting app's secret values left in the store: encrypted, never read again, now swept at the next start. Not something a user sees, so no entry.)

### An agent moved to another machine lost a tool its image had (a package it used is "not found" there)
- **Check:** the agent is pinned to a derived image or a `-plus-…` image; after "Move to another machine" its tool calls fail with `command not found` for a package its image's labels list; the move's log says the image was rebuilt from its recipe.
- **Cause:** the recipe is read from the source machine's image list. When that read failed for a moment, the recipe took it as "no extra packages" and rebuilt the image without them.
- **Fix:** move the agent back, and then move it again once the source machine answers. Since the fix, an image list that can't be read gives no recipe ("could not be read just now … try again"), and the move offers the destination's default image instead of a thinner copy.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/imageRecipe.ts` — `recipeFor`, `ensureImageOn`

### A restore was interrupted and now says "That snapshot no longer exists"
- **Check:** the agent had 20 automatic snapshots (Files → Snapshots); a restore of the oldest one was interrupted (a restart part-way), and Alerts offers to finish it, but finishing fails because the snapshot is gone.
- **Cause:** the restore first takes a safety snapshot of the current files. At the 20-snapshot limit, taking it pruned the oldest automatic one, which was the snapshot being restored.
- **Fix:** choose "revert" in Alerts: the safety snapshot ("before restoring …") still holds the files as they were. Since the fix, pruning never removes a snapshot the agent's unfinished operation names.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/snapshots.ts` — `captureSnapshot`, `restoreSnapshot`; `src/store/store.ts` — `pruneAutoSnapshots`

### A template's scheduled task appears twice on a new agent
- **Check:** the agent was made from a template with scheduled tasks; its Tasks page lists one of them twice with the same name and schedule; its log has `schedule.applied` for that name on two builds.
- **Cause:** before adding a template's tasks, a build reads the tasks already there and skips those. When that read failed, it was taken as "none there", and a task whose first add had landed (its answer lost) was added again.
- **Fix:** delete the extra copy in the Tasks page. Since the fix, a failed read keeps the template's tasks waiting for the next rebuild (`schedule.list_failed` in the log) instead of adding them blind.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/provision.ts` — `runProvisionSteps`; `src/orchestrator/crons.ts` — `listCrons`

### The weekly token review arrives at the wrong hour
- **Check:** `HATCHABOT_TIMEZONE` is set to a zone different from the machine's; the Hatchabot agent's "Weekly token review" task shows `0 9 * * 1` with the machine's zone, not the one set.
- **Cause:** the task was made in the machine's zone, while every other agent clock follows `HATCHABOT_TIMEZONE`.
- **Fix:** edit the task's zone in the Tasks page, or delete it and rebuild the Hatchabot agent (the build makes it again). Since the fix, a new review task uses the agents' zone.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/modelReview.ts` — `syncModelReviewCron`; `src/orchestrator/timezone.ts` — `agentTimeZone`

### A model change says "0 turns since the switch" although the agent was busy
- **Check:** the model ledger shows two changes for the agent within the same hour; the first one's verdict is "not enough data" with "0 turns on … since the switch".
- **Cause:** the ledger counts turns per hour, and a period shorter than one hour bucket has no whole hour of its own, so it summed nothing. The verdict was right (too little to judge); the reason was not.
- **Fix:** nothing to do. Since the fix, the reason says the model was changed again within the hour, too soon to tell its turns apart.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/modelLedger.ts` — `evaluateModelChanges`, `afterFigures`

### The quality guard said a model did worse, but no switch-back card came
- **Check:** the model ledger shows a change judged "worse"; Alerts has no "Switch … back" card for it; the service log has a database error (often a full disk) from around then.
- **Cause:** the guard marked the change as having its card before writing the card. When the write failed, the mark stayed, and no later pass filed it.
- **Fix:** free some disk space. Since the fix, a card that can't be written gives its mark back (`model.guard_failed` in the log), and the next pass files it.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/modelLedger.ts` — `fileGuardProposals`; `src/store/store.ts` — `releaseModelChangeGuard`

### The weekly review still runs after `HATCHABOT_MODEL_REVIEW=off` (under its old name)
- **Check:** the Hatchabot agent's tasks list both "Weekly token review" and "Weekly model review", or one of them after the review was turned off; the agent was imported or restored.
- **Cause:** with the review off, a build removed only the first task it found under either name.
- **Fix:** delete the remaining one in the Tasks page. Since the fix, turning it off removes every task under either name.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/modelReview.ts` — `syncModelReviewCron`

### An agent's tasks are there twice after "Adopt" was run again
- **Check:** the adopted agent's Tasks page lists the old install's tasks twice, all disabled; Adopt was run again for the same agent, or retried after some tasks failed.
- **Cause:** each adopt added every task from the old install again; the tasks already brought over were not looked for.
- **Fix:** delete the extra copies. Since the fix, a task already there with the same name and schedule is counted as brought over and not added again (`cron.migrate_already_present`).
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/cronImport.ts` — `migrateCrons`

### An adopted task with an interval like 1.5 seconds was not brought over
- **Check:** the adopt summary counts a task as not brought over; the log has `cron.migrate_unmappable` with kind `every`; in the old install the task's `everyMs` is not a whole number of seconds.
- **Cause:** it used to be rounded to the nearest second (1500 ms became 2 s, a third less often). Since the fix, an interval that can't be written exactly is reported instead of changed.
- **Fix:** make the task again in the Tasks page with an interval of whole seconds.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/cronImport.ts` — `cronAddArgs`

### An agent paused by its budget started again although the machine's budget was still used up
- **Check:** the agent's timeline shows "started again: its budget was raised" while Settings → Budgets shows the machine's budget (set to pause) at or over 100%. It is paused again at the next budget pass, a few minutes later.
- **Cause:** when its own budget was raised, the budget pass checked only the budget that had paused it, not the machine's, so it started an agent another budget still held.
- **Fix:** upgrade. Since the fix, an agent stays paused while any pause budget that covers it (its own or the machine's) is still reached.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/budgets.ts` — `runBudgets`

### After adopting an agent, a folder it uses was not offered for sharing because its name has a space
- **Check:** the adopted agent's files name the folder in quotes or backticks (`"/home/you/My Documents"`), and the data-folder step after adopt does not list it.
- **Cause:** the scan read a path only up to its first space, so `/home/you/My` was looked for and not found.
- **Fix:** share the folder by hand from the agent's Data tab, or upgrade and scan again. Since the fix, a quoted path with spaces is found.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/dataPaths.ts` — `scanWorkspacePaths`

### A token-use warning never arrived, and no other came that day
- **Check:** Usage shows the spike warning, but the owner had no Telegram message for it; the manager's chat app was down or unreachable when it was first sent.
- **Cause:** a warning that failed to send was recorded all the same, and that record counted as "already told" for 24 hours.
- **Fix:** upgrade. Since the fix, a warning that did not reach its owner is tried again every hour until it does.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/usageAlerts.ts` — `runUsageAlerts`; `src/store/store.ts` — `markUsageAlertTold`

### An agent restored from a Download copy, or moved to another Hatchabot, runs out of memory where it did not before
- **Check:** the source agent had its own memory cap or swap allowance (its sheet → Advanced); the copy here shows the default.
- **Cause:** a Download copy did not carry the agent's own cap or swap allowance, so the copy got the receiving machine's defaults.
- **Fix:** set the cap again on its sheet (Advanced → Memory cap), or upgrade both ends and export again. Since the fix, the copy carries both, applied under the receiving machine's rules (a member's import is held to its per-agent maximum).
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/transfer.ts` — `importedLimits`, `exportAgent`, `importAgent`

### On a busy machine, some agents' token use and rate limits are never counted
- **Check:** the service log shows `usage.sample_incomplete` most passes, and the same agents show no recent use under Usage while they are clearly busy.
- **Cause:** each usage pass sampled agents in the same order and stopped after five minutes, so slow agents at the front used up the time and the same agents at the back were never reached.
- **Fix:** upgrade. Since the fix, each pass starts with the agents sampled longest ago.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/sourceUsage.ts` — `sampleSourceUsage`

### Alerts does not show a loop that is still going
- **Check:** `GET /v1/token-incidents` lists more than 100 incidents cleared in the last week, and an older incident is still open (Recommended still shows its fix).
- **Cause:** the list read the newest 100 incidents and then split them into open and cleared, so 100 newer cleared ones pushed an older open one out.
- **Fix:** upgrade. Since the fix, open incidents are read on their own.
- **Fixed in:** `v2.164.2`
- **Code:** `src/api/routes.ts` — the `/v1/token-incidents` route

### "Not logged in · Please run /login" keeps coming back on an older conversation of an agent with many conversations
- **Check:** the agent has more than 500 conversations (`openclaw gateway call sessions.list`), and the one that fails is not among the newest 500.
- **Cause:** the stale runtime pin cleanup read only the first 500 conversations, so a pin to the old runtime on any later one was never cleared.
- **Fix:** upgrade and restart the agent. Since the fix, the cleanup reads every page of conversations.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/runtimePins.ts` — `listRuntimePins`, `clearStaleRuntimePins`

### A day's cost on the Usage trend went down after an agent was deleted
- **Check:** the trend's cost for today or yesterday dropped right after an API-keyed agent was deleted.
- **Cause:** each pass re-summed the day's cost over the agents still there and wrote it over the recorded one, so a deleted agent's spending dropped out.
- **Fix:** upgrade. Since the fix, a deleted agent's use still counts on the days it spent.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/fleetUsage.ts` — `snapshotDailyUsage`; `src/store/store.ts` — `listDeletedAgents`

### The cost estimate is too high for an agent moved between two API keys
- **Check:** under Usage, the agent's tokens in the window were spent on two API sources with different models (say Opus, then Haiku), and the estimate prices all of them at the dearer model.
- **Cause:** with no measured rate for the agent, all its API tokens were priced at one model, that of the source that carried the most.
- **Fix:** upgrade. Since the fix, each source's tokens are priced at its own model.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/fleetUsage.ts` — `computeUsagePeriod`

### The Usage trend has a gap for the day Hatchabot was down at midnight
- **Check:** the trend has no point for a day Hatchabot was stopped or restarting across midnight, though the agents' readings for that day exist.
- **Cause:** the pass after midnight finished yesterday's row only if one was already there, and made only today's.
- **Fix:** upgrade. Since the fix, a missing row for yesterday is made from the readings as they stood at midnight.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/fleetUsage.ts` — `snapshotDailyUsage`; `src/store/store.ts` — `addUsageSnapshotIfMissing`, `latestTokenTotalBefore`

### An agent's Logs or Setup log showed another agent's lines
- **Check:** you opened one agent's Logs (or Setup log), then another's before the first had loaded, on a slow machine or a runner far away. The lines that showed belong to the first agent.
- **Cause:** the panel painted whichever read answered last, so a slow answer for the agent opened first wrote over the one opened since.
- **Fix:** open the logs again. Since the fix, only the newest read paints.
- **Fixed in:** `v2.164.2`
- **Code:** `web/index.html` — `loadLogs`, `loadSetupLog`

### The file editor closed by itself, and what you were typing was lost
- **Check:** you saved a file, then opened another agent's (or another) file in the editor before the save finished; the editor closed while you typed.
- **Cause:** the first save's answer closed whatever the editor showed when it came back.
- **Fix:** open the file again and redo the edit. Since the fix, a save closes the editor only if it is still showing the file it saved. If the editor has moved on, the save is reported in a toast.
- **Fixed in:** `v2.164.2`
- **Code:** `web/index.html` — `saveEditFile`, `loadEditFile`

### A problem report draft showed another draft's text after a save
- **Check:** in Report a problem, you pressed Copy, Save as a file or Open on GitHub on one draft, then opened another draft before it finished; the second draft's title or text changed to the first's.
- **Cause:** the save's answer replaced the draft the page showed, whichever it was by then.
- **Fix:** open the draft again from the list. Since the fix, the save carries on with its own draft and leaves the one shown as it is.
- **Fixed in:** `v2.164.2`
- **Code:** `web/index.html` — `reportSaveEdits`

### A Google account was reported removed from an agent but was still there
- **Check:** the agent's activity has `connection.removed_from_agent` for the account, but `gog auth list` inside the agent still names it, or lists entries with no `email` field.
- **Cause:** the list of accounts gog printed was read leniently: an entry without an email was dropped, so a list that did name the account (in another shape) read as "not there", and a failed remove passed as done.
- **Fix:** detach the account again, or run Verify on the agent. Since the fix, a list with any entry Hatchabot cannot read is no answer, and the removal stays pending until a clean list shows it gone.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/googleConnections.ts` — `gogAccounts`, `dematerializeConnection`

### Strangers could still knock on an agent's Telegram bot after its owner linked
- **Check:** the owner's first Telegram message was claimed, but the agent's Telegram door stayed on `pairing` (its config's `dmPolicy`) while a Discord or Slack invite window was open on the same agent.
- **Cause:** when a claim window closed, any other open window on the agent kept the door open, even one for another chat app.
- **Fix:** it closes by itself when the other window ends. Since the fix, only the same chat app's windows hold its door open.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/claim.ts` — `claimFirstContact`, `restoreDoor`

### The owner's first message to a new bot was never claimed
- **Check:** the agent's activity shows "its pairing requests could not be read; trying again" (`claim.read_failed`), or (before the fix) the claim window stayed listed with nothing watching it. The person messaged the bot and was never let in.
- **Cause:** a read of the pairing requests that threw (a `docker exec` that failed) ended the watcher, and the window it was watching stayed stored.
- **Fix:** let them in from Alerts, or send a new invite. Since the fix, a failed read (or approve) is tried again on the next round, and said once.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/claim.ts` — `claimFirstContact`, `listPairingRequests`

### Telegram attached to a stopped agent: the owner's first message was not claimed, and a "That's me" card came instead
- **Check:** Telegram was attached (or a guest invited) while the agent was stopped, rebuilding or starting; its activity shows "the first-contact window closed" about 30 minutes later, before or soon after it started.
- **Cause:** the 30 minutes of the window ran from the attach, with the agent down, and nothing could be claimed until it ran.
- **Fix:** tap **That's me** on the card, or **Let them in again** under Members. Since the fix the window's time runs only while the agent is up: down, a window for a named guest waits for it (a week at most, then it ends with "the first-contact window was given up"). A window open to anyone (a new bot waiting for its owner's first message) waits at most an hour from when it opened, so a stranger writing days later never becomes the owner; it ends with "the first-contact window ended: the agent was down past the hour…", and the owner opens a new one once the agent is up. While it is down the stored window is kept open past the next look, so a rebuild that ends between two looks still opens the door; once it is up the door is opened again, and the stored window runs to the same end, so another guest's window closing does not shut the door early. A window closed by hand while the agent is down ends there ("the first-contact window was closed elsewhere"). A move while the window waits is waited out like a rebuild: a move that is undone leaves the window as it was. Once a move has finished and the agent is up on the new machine, the window ends there ("the agent moved to another machine") and the door on the new machine is put back to rest (members only): open a new window, which watches the new machine.
- **Fixed in:** `v2.178.0`
- **Code:** `src/orchestrator/claim.ts` — `claimFirstContact`, `followDeadline`, `restoreDoor`; `src/store/store.ts` — `activeOperationFor`

### An agent went to sleep just after it answered
- **Check:** sleep (`HATCHABOT_HIBERNATE_AFTER`) is on. The agent's timeline shows `agent.hibernated` within seconds of a reply it sent, and its next message had to wake it.
- **Cause:** the idle sweep read the agent's activity, then its scheduled tasks; a conversation that finished in between was not seen, and under the lock only the settings were judged again.
- **Fix:** none needed; a message wakes it. Since the fix, its activity is read again just before the stop, and anything newer keeps it up.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/hibernate.ts` — `hibernateAgent`, `hibernateSweep`, `idleBlocker`

### A guest whose web chat was turned off got one more answer
- **Check:** web chat was turned off for a guest (or they were removed) while the agent was asleep and their message was waking it; that message was still answered.
- **Cause:** web chat was checked before the wake, which takes seconds, and not again before the message was sent.
- **Fix:** none needed; later messages are refused. Since the fix, it is checked again after the wake, and the message is refused (403).
- **Fixed in:** `v2.164.2`
- **Code:** `src/api/webChat.ts` — `/v1/agents/:id/chat`

### Verify did not notice a Discord or Slack bot running another token
- **Check:** the agent's Discord or Slack bot answers as a different bot than the one in Hatchabot, yet What it can reach shows the bot with no "a different bot token is running".
- **Cause:** only Telegram's token was compared with the one Hatchabot holds.
- **Fix:** run Verify again after upgrading; a mismatch shows as "a different bot token is running — rebuild it". Since the fix, every chat app's token is compared (Slack's bot token, which Hatchabot keeps with the app token).
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/accessOverview.ts` — `verifyNow`, `botTokenOf`

### What it can reach said someone could still talk to an agent on a chat app that is off
- **Check:** a person shows as still let in (an alert after removing them) but the chat app or the account they were on is turned off in the agent's OpenClaw settings (`enabled: false`).
- **Cause:** the check counted the allow lists of turned-off chat apps and accounts as access.
- **Fix:** run Verify again after upgrading. Since the fix, a turned-off chat app or account admits nobody in the check.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/accessOverview.ts` — `accessProbeScript`

### A cloned agent's app could not log in: a credential was missing from the copy
- **Check:** the clone's Advanced → Extra credentials lacks a variable the original has; its activity says "cloned without the credentials that could not be read" (`agent.clone_env_skipped`).
- **Cause:** a credential whose stored value could not be read was skipped in silence; the clone was built without it.
- **Fix:** add the variable to the clone under Advanced → Extra credentials. Since the fix, the clone's message names each one left out.
- **Fixed in:** `v2.164.2`
- **Code:** `src/api/routes.ts` — the `/v1/agents/:id/clone` route; `web/index.html` — `cloneAgent`

### The bot census called a rebuilding agent's bot reclaimable
- **Check:** `hatchabot bots` listed a bot as reclaimable while its agent was being built or rebuilt; with live checks, the census polled that bot.
- **Cause:** only a running or sleeping agent's bot counted as in use; a build in progress may still have its gateway polling.
- **Fix:** don't reclaim it; run the census again once the build is done. Since the fix, only an agent at rest (stopped by hand, archived, failed) leaves its bot reclaimable, and a bot in use is never polled.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/bots.ts` — `auditBots`

### A guest's agent icon showed unread with nothing new for them
- **Check:** you chat with someone else's agent on the web, and its icon (or Recent) shows unread, but your own conversation has nothing new.
- **Cause:** the mark counted every conversation on the agent, including the owner's and other guests', which a guest cannot open.
- **Fix:** none needed. Since the fix, a guest's mark is their own conversation's; a member without web chat gets none.
- **Fixed in:** `v2.164.2`
- **Code:** `src/api/routes.ts` — `unreadFor`; `src/orchestrator/unread.ts` — `consoleActivity`

### Leftover hatchabot-caps containers after the Runtime tab timed out
- **Check:** `docker ps` shows a `hatchabot-caps-…` container (or an unnamed one running `bash -c` from an agent image) that has been up for a long time.
- **Cause:** a capability probe that timed out killed the docker client, but the container kept running; `--rm` acts only when it exits.
- **Fix:** `docker rm -f` it. Since the fix, the probe names its container and removes it when it times out.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/runtimeCaps.ts` — `probeImageCapabilities`

### Adopt brought over none of the scheduled tasks made with `openclaw cron add` (no --agent)
- **Check:** the old install's tasks were made without `--agent`; in its state database, `sqlite3 ~/.openclaw/state.sqlite "select count(*) from cron_jobs where agent_id is null"` is above 0, and the adopted agent was the old install's default (the entry marked `default`, else the first).
- **Cause:** OpenClaw stores such a task with no agent and runs it as the default agent, but adopt read only the tasks stored under the agent's own id.
- **Fix:** upgrade, then adopt again: tasks with no agent come with the default agent (an adopt run again skips those already there).
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/cronImport.ts` — `readOpenclawCronStore`, `openclawDefaultAgentId`

### Update says "Needs a value for: …" and the page gives nowhere to type it
- **Check:** the app's newest release has a required setup field the installed copy has no value for (a field made required, or one an older version left blank); Update on the agent's page fails with "Needs a value for".
- **Cause:** the page's Update sent no values, and the message asked for them as `key=value`, which only the CLI takes.
- **Fix:** upgrade: Update asks for the missing values under the app's row ("Update with these"). Meanwhile, `hatchabot app update <agent> key=value`. If the agent's page was on another tab, or another agent's page was open, when the answer came, a message names the agent and says to give the value on its Overview, under App, and press Update again (since `v2.178.0`).
- **Fixed in:** `v2.164.2`; the message when the App row is not on screen: `v2.178.0`
- **Code:** `src/orchestrator/apps.ts` — `mergeConfig`, `installRelease`; `web/index.html` — `v2AppUpdate`, `v2AppAskValues`

### Raising an agent's "cheaper model" budget switched it back, then the next pass switched it down again
- **Check:** the agent's own budget and the machine's are both set to "cheaper model". You raised the agent's own while the machine's was still over 100%, and its model ledger shows the budget's switch back to its own model and, minutes later, to the cheap one again.
- **Cause:** its own model came back as soon as the budget that had moved it was no longer reached, even though another cheaper-model budget that covers it, the machine's, still was. A pause already waited for every pause budget that covers the agent.
- **Fix:** upgrade. The agent stays on the cheaper model until every cheaper-model budget that covers it is under its limit, or until the 1st. To have it back on its own model now, raise the machine's budget too.
- **Fixed in:** `v2.164.2`
- **Code:** `src/orchestrator/budgets.ts` — `runBudgets`

### An agent's volume went missing and it looked healthy with no memory, or a change "worked" on nothing
- **Check:** `docker volume inspect <container>-vol` says "no such volume", or was recreated recently with almost nothing in it. Since the fix, changing a stopped agent's model (or its class's), its file limit, adopting a workspace into it, admitting or removing someone, unlinking your Discord, or opening Files says "This agent's stored files are not on its machine: its volume is gone." (or the same in other words). Those changes used to say "try again, or Rebuild it", "Adopt again" or "is the machine it runs on awake?", none of which can work.
- **Cause:** `docker run -v` creates a volume that is not there. Writing to a stopped agent's volume, uploading, or downloading made an empty one, so the loss looked like an agent that had forgotten everything. Only read-only looks and copies asked first.
- **Fix:** upgrade, then find out why it went (a `docker volume prune`, a Docker reinstall, the agent recorded on the wrong machine). A rebuild makes a fresh, empty volume and seeds it. Removing a member, and unlinking your Discord from that agent, stays refused until the agent has its files back or is deleted, since another machine may still hold the allowlist. A restore from a backup is also refused while the volume is gone, because it has no way to go back; rebuild first, then restore.
- **Fixed in:** `v2.172.0`
- **Code:** `src/providers/localDockerProvider.ts` — `execShellOnVolume`, `writeToVolume`, `streamFromVolume`, `importWorkspace`; `src/orchestrator/members.ts` — `revokeMember`, `denyPairing`, `grantChannelAccess`; `src/orchestrator/adopt.ts` — `applyWorkspace`; `src/api/routes.ts` — `applyModelNow`, `applyFilesCap`, `'/v1/account/discord'`

### A restore or a move of a large agent was refused at about 1 GB compressed
- **Check:** the restore said "Its current state could not be copied first", or the move "Couldn't read the agent's state", and the log shows `maxBuffer` for that agent.
- **Cause:** the copy of its volume was held in one Buffer in the Hatchabot process, capped at 1 GB.
- **Fix:** upgrade. The copy now goes to a private file (`restore-safety-<install's mark>/` beside the backups for a restore, `move-copies/` in the data folder for a move, so a backup folder on a NAS plays no part in a move) and needs that much free disk there; a full disk says so and nothing is changed, whether it is the copy or the backup being staged that does not fit. Download copy still has its own limit of about 190 MB. A copy past `HATCHABOT_DOCKER_IO_TIMEOUT_MS` (15 minutes) still fails, with nothing changed; raise it for a very large agent. A move also stays under `HATCHABOT_IMPORT_MAX_GB` on the machine it goes to.
- **Fixed in:** `v2.172.0`
- **Code:** `src/providers/localDockerProvider.ts` — `exportStateToFile`, `importStateFromFile`; `src/orchestrator/backups.ts` — `restoreAgentFromBackup`, `newMoveCopy`, `sweepMoveCopies`; `src/orchestrator/moveHost.ts` — `moveAgentToHost`

### A restore on a nearly full disk left a healthy agent FAILED, "its memory may be half-restored"
- **Check:** the agent's failure names a safety copy under `restore-safety-<install's mark>/` (`restore-safety/` before this), both failures in the message say `No space left on device`, and `df` shows the disk nearly full. Its volume is as it was before the restore.
- **Cause:** the backup failed to stage on the disk before the volume was emptied, and the rollback then staged the safety copy the same way, which failed too. The rollback did not ask whether the volume had been touched.
- **Fix:** upgrade: a restore that stops before the volume is emptied now restarts the agent and says "the agent was left as it was". Already in this state: free some space, then restore that backup again (or tap Retry once you have checked the volume with Files); the safety copy can go once it is back.
- **Fixed in:** `v2.172.0`
- **Code:** `src/orchestrator/backups.ts` — `restoreSteps`, `rollBack`; `src/providers/localDockerProvider.ts` — `importStateFromFile`; `src/providers/provider.ts` — `VolumeUntouchedError`

### A restore that Docker refused to make or start ("no space left on device", exit 125), or whose runner dropped first, left the agent FAILED and "half-restored"
- **Check:** the failure's two messages both say `volume import failed (125)` with `Error response from daemon` and `no space left on device` (at `mkdir /var/lib/docker/...` or `failed to create task`), or the runner "isn't answering", and the agent's volume, looked at with Files once there is room, is as it was before the restore. The safety copy named in the failure is there.
- **Cause:** Docker refused to make the one-shot that unpacks the backup, or made it and could not start it (it had no room, or could not reach the runner), so nothing touched the volume. Docker gives the same exit, 125, when it loses a one-shot that is already unpacking, so the restore could not tell them apart, went to put the safety copy back, failed the same way, and marked the agent FAILED. The 2.172 fix for a full disk covered only failures inside the one-shot.
- **Fix:** upgrade. The one-shot is no longer removed by Docker on exit (`--rm`): after a failure Hatchabot asks Docker whether it ever ran (its start time), then removes it itself. Docker also writes its id to a private file when it makes it, so a failure with no id is known to have made nothing, whatever it exited with (a daemon or runner it could not reach exits 1). Either way the restore starts the agent again if it was running and its record says "the agent was left as it was", with the reason. A runner that does not answer before the import is the same; if the agent then cannot be started, the record says it is stopped and to start it once its machine answers. A docker CLI that cannot write that file (a confined install: exit 126 or 127, "failed to create the container ID file") imports as before, without it. The one-shot deletes its staged copy of the archive when its script ends, and one left behind is swept at boot and every 10 minutes, on runners too. Not when Docker itself stops it (`docker stop`, the daemon shutting down, the runner powering off): its shell is killed after the grace period, and the staged archive, with the agent's credentials, stays in the exited container until the next sweep; removing a runner does not remove it, so remove `docker ps -a --filter label=hatchabot.oneshot` containers on a runner you retire. Already in this state: free some space (or wake the runner), then restore the backup again, or put the safety copy back; the copy can go once the agent is back.
- **Fixed in:** `v2.174.0`
- **Code:** `src/providers/localDockerProvider.ts` — `importStateFromFile`, `idFileFor`, `#settleOneShot`, `#inspectOneShot`; `src/orchestrator/backups.ts` — `restoreSteps`, `restartAfterRestore`; `src/providers/provider.ts` — `VolumeUntouchedError`

### A restore failed while its runner's link dropped, and the agent came back "left as it was" with odd or missing memory
- **Check:** the restore's failure says `volume import failed (125)` (often `error waiting for container`) or `timed out`, the runner's link dropped or it slept around then, and `docker ps -a --filter label=hatchabot.oneshot` on that machine showed a one-shot still running after the restore ended. Since the fix, the agent is instead left FAILED with "the container that was unpacking it (…) could not be confirmed gone, so putting it back did not begin", and the safety copy is kept; a later restore says "an earlier copy into its memory may still be running" until that container is gone.
- **Cause:** when the unpacking failed, its one-shot was removed with `docker rm -f`, but a failed removal was ignored. If the link came back just after (or a sleeping runner woke and its `tar` went on), the rollback or the next restore unpacked alongside the first one-shot, so the volume could hold a mix of the two, and the safety copy was then deleted.
- **Fix:** upgrade: a failed one-shot is now removed and confirmed gone, or seen finished, before anything else writes the volume; Docker is asked three times a few seconds apart, each time checking afresh that a runner answers. If it cannot be shown gone, the restore does not put the copy back: the agent stays stopped and FAILED and the copy is kept. Every later restore, Put back, Finish and import first looks for this install's one-shots still writing that volume and removes them, or does not begin and names the one left; read-only ones (the nightly backup, a Download) are left running. A restore, Put back or Finish also waits while a backup is being made: "A backup is being made right now … Try again once it finishes." Only a live run's lock on today's or yesterday's set of this install counts, and not one over 12 hours old. By hand: remove that container (`docker rm -f <name>`, as the failure says) before putting the copy back yourself.
- **Fixed in:** `v2.174.0`
- **Code:** `src/providers/localDockerProvider.ts` — `importStateFromFile`, `stopVolumeWriters`, `#clearVolumeWriters`, `#settleOneShot`, `sweepOneShots`; `src/orchestrator/backups.ts` — `rollBack`, `confirmStopped`, `backupRunning`; `src/providers/provider.ts` — `OneShotNotGoneError`; `src/index.ts` — `sweepOneShots`

### A Files edit, a setting or an adopt fails with "an earlier copy is still writing to the agent's files"
- **Check:** `docker ps --filter label=hatchabot.oneshot --filter volume=<the agent's volume>` on its machine lists a one-shot still running, usually after a copy timed out, the service restarted mid-copy, or a runner's link dropped.
- **Cause:** a one-shot whose call had ended (a timeout, a restart) went on writing the agent's files. Before the fix, edits, config writes and an adopt's copy wrote alongside it, so the two could interleave; only a restore looked for one first.
- **Fix:** upgrade. A write now removes such a one-shot first. Only one Docker says writes there is removed: readers (the nightly backup, a copy being taken, a Download) are left alone, and so are this service's own writes under way. A one-shot Docker does not say how it mounts the volume is left alone too: when the look at the mounts fails or runs out of time, the write goes ahead as for a listing that failed (below, "how … mount its files could not be read"); when Docker answers without it, see "couldn't check what else is writing to its files" below. It looks the first time it writes to an agent after the service starts, and again only after a write there timed out, was cut off, or ended in an error with its one-shot still there (a dropped link to a runner exits 255), so most writes cost no extra docker call. When the one-shot cannot be removed, nothing is written and the message names it: wait a few minutes and try again, or remove it with `docker rm -f <name>`. When the list of containers cannot be read, the write goes ahead, the agent's activity says "the copies that might still be writing there could not be listed; written anyway", and writes there go ahead without asking for five minutes (or until a write there is given up), then ask again (said once until a listing works).
- **Fixed in:** `v2.178.0`
- **Code:** `src/providers/localDockerProvider.ts` — `#clearVolumeWriters`, `#everydayWrite`, `#runOneShot`, `#runStdin`, `#oneShotExit`, `#track`, `#gaveUpOn`, `#endedBadly`, `setVolumeEventSink`, `execShellOnVolume`, `writeToVolume`, `importWorkspace`, `#seed`; `src/orchestrator/operations.ts` — `runtimeEventLog`

### A Files edit, a setting or an adopt fails with "a restore is running on this agent's files; try again when it ends"
- **Check:** the agent is being restored from a snapshot or a backup, or brought in by a move or an import, right now: its activity shows the restore under way.
- **Cause:** a restore empties the agent's files and unpacks the copy in their place. A write made meanwhile would land in the middle of that, or be wiped by it. So the agent's files are locked: each write holds the lock, shared with other writes, from its check for earlier copies until it has ended, and a restore takes it for itself. From the moment a restore asks for it until it ends, however long that takes, a new write is refused; writes already under way finish first, and the restore waits for them. A restore that failed with its copy still unpacking counts as running until that copy is removed.
- **Fix:** wait for the restore to finish, then try again. Nothing was written.
- **Fixed in:** `v2.178.0`
- **Code:** `src/providers/localDockerProvider.ts` — `#everydayWrite`, `shareVolume`, `holdVolume`, `stopVolumeWriters`, `importStateFromFile`, `#importVolume`, `#oneShotExit`

### A Files edit, a setting or an adopt fails with "couldn't check what else is writing to its files; try again"
- **Check:** on the agent's machine, `docker ps --filter label=hatchabot.oneshot --filter volume=<the agent's volume>` lists a one-shot whose name is not a reader's (`-bk-`, `-ex-`, `-fs-`, `-ro-`), and `docker container inspect <name>` answers without that volume among its mounts. It comes only when a write there was cut off or timed out earlier, or on the first write after the service started.
- **Cause:** before a write, Hatchabot removes any one-shot left writing that agent's files. Docker answered without saying whether this one writes there or only reads, so it was neither removed nor written beside. (One Docker says is gone by then, having ended since it was listed, does not count; and when the inspect itself fails or runs out of time, the write goes ahead, the agent's activity saying "written anyway: how … mount its files could not be read", and the look waits five minutes.) Before the fix it was taken for a writer and removed, and when it was the nightly backup's copy that night's set failed.
- **Fix:** try again in a minute. If it keeps happening, Docker on that machine is not answering: check it with `docker info`, or remove the one-shot named by `docker ps` with `docker rm -f <name>` once you know it is not a backup still running.
- **Fixed in:** `v2.178.0`
- **Code:** `src/providers/localDockerProvider.ts` — `#clearVolumeWriters`, `#reads`, `#everydayWrite`, `importWorkspace`

### A move was cancelled with "Couldn't read the agent's state ... ENOENT ... .tgz.part"
- **Check:** the message or the log names a `.tgz.part` under `move-copies` or `restore-safety`, and another move or restore ended around that time, or, for `restore-safety`, another Hatchabot install shares this backup folder and started then. The source agent is untouched; a retry works.
- **Cause:** the private folder was removed when one operation's copy left it empty, while another had made it and not yet opened its file. Two installs sharing a backup folder also shared one such folder, and one owned by another user refused the operation altogether.
- **Fix:** upgrade: the folder stays while a copy is on its way. A move's copy goes in this install's data folder (`move-copies/`), and each install has its own `restore-safety-<mark>` folder, with the mark its backup sets carry in `.backup-owner`.
- **Fixed in:** `v2.172.0`
- **Code:** `src/orchestrator/backups.ts` — `newMoveCopy`, `dropMoveCopy`, `dropSafetyCopy`, `sweepMoveCopies`

### A deploy or upgrade fails every time on ".git/index.lock: File exists" after it was killed
- **Check:** `ls <install>/.git/index.lock` finds it, and `~/.local/state/hatchabot/upgrade-*.from` is there beside the lock: a deploy or upgrade was killed (SIGKILL, a power cut) in its `git checkout`. The output says "index.lock is in the way" or "index.lock is held, so nothing was changed".
- **Cause:** a killed git leaves its lock, every later checkout fails on it, and a plain checkout back kept the files it had rewritten, so later runs refused them as local changes.
- **Fix:** upgrade, then run it again. A deploy or upgrade now writes in its record which git it started, and removes the lock only when that git is gone, no other git is running in the checkout (a `git commit` waiting in its editor holds it for as long as the person takes), the lock is no older than the record and a couple of minutes old; it then puts every tracked file back (`.env` and `data/` are not touched). A tracked file that matches neither release, such as a hand edit made since the kill, is copied first and named: the copy is in `~/.local/state/hatchabot/upgrade-*.kept-<time>/`. A lock it cannot show is its own stays and is named: check no git is running there (`pgrep -a git`), then `rm <install>/.git/index.lock`. One left by a kill under an older release is that case. When only git was killed, the run puts the dependencies back at once and a later run clears the lock.
- **Fixed in:** `v2.172.0`
- **Code:** `scripts/deploy-release.sh` — `checkout_recorded`, `git_running_here`, `clear_own_index_lock`, `save_other_edits`, `repair_tree`; `scripts/upgrade.sh` — `checkout_recorded`, `git_running_here`, `clear_own_index_lock`, `save_other_edits`, `repair_tree`

### An install pinned to a version stays half upgraded although its channel timer runs
- **Check:** `data/channel` holds a version (`v2.31.3`), a `hatchabot upgrade vX.Y.Z` was killed part-way, and `.swapping` in the install or `~/.local/state/hatchabot/upgrade-*.from` is there; `journalctl --user -u hatchabot-follow-channel` shows the timer doing nothing.
- **Cause:** the timer left a pinned install alone before it looked for an upgrade to repair, so only the next `hatchabot upgrade` by hand repaired it.
- **Fix:** upgrade, or run `hatchabot upgrade` once by hand. The next tick now puts the earlier release back and finishes the upgrade to the release pinned; after that the timer leaves the pin alone again. From `v2.173.0`, if it cannot finish, the pin comes off (see `hatchabot upgrade vX.Y.Z` failed, above).
- **Fixed in:** `v2.172.0`
- **Code:** `scripts/follow-channel.sh` — `PINNED`

### The follow-latest timer fails every tick with "Not deploying" after a hand deploy was killed
- **Check:** `~/.local/state/hatchabot/upgrade-*.from` is there, and either `journalctl --user -u hatchabot-follow-latest` repeats "Not deploying vX.Y.Z", or the deploy killed was of a tag newer than the newest followed one (an rc) and the timer says nothing at all.
- **Cause:** the timer asked whether the newest tag may be deployed before it repaired anything, and passed over a checkout ahead of the newest tag, so the repair in `deploy-release.sh` never ran.
- **Fix:** upgrade, or `scripts/deploy-release.sh <the release it was on>` by hand. The timer now puts the release the killed deploy came from back with that release's own deploy script, running none of the refused tag's code, and does not take a checkout backwards to reach the newest tag. That reinstalls and restarts the release once.
- **Fixed in:** `v2.172.0`
- **Code:** `scripts/follow-latest.sh` — `repair_cut`, `CUT_FROM`

### An upgrade stops with "Could not move <install>/<folder> aside." on a bundle install
- **Check:** `findmnt <install>/<folder>` (on a Mac, `mount | grep <install>`) shows that folder is a mount point, one the release replaces, such as `node_modules` on its own disk. `mv` says "Device or resource busy".
- **Cause:** a bundle upgrade moves each of its folders aside, and a mount point cannot be moved. The upgrade stops, the earlier release goes back and nothing on the mount is touched, but every later try stops the same way.
- **Fix:** nothing to repair: unmount that folder, or point the mount somewhere the release does not own (`data/` and `.env` are never replaced), then `hatchabot upgrade`. A mounted folder inside the install cannot be upgraded in place, so this stays a refusal.
- **Fixed in:** —
- **Code:** `scripts/upgrade.sh` — `restore_prev`, `not_ours`

### Uninstall --backups leaves the backup folder with a `drills` folder in it, and said it "holds more than Hatchabot's backup sets"
- **Check:** `ls <backups>/drills` shows dated `.json` records after `hatchabot uninstall --purge --backups`. Its plan and "kept" note may also have counted more sets than there are dated folders.
- **Cause:** the removal took only dated sets and restore-safety folders, so a restore drill's records stayed, naming agents' volumes, and the count was every entry in the folder.
- **Fix:** delete `<backups>/drills` by hand if no other install shares that folder, then the folder itself. Now `--backups` removes the records it can tell are this install's: by the mark a record carries from `v2.173.0`, or for an older one by the set it names, if that set is still there and says so. Whatever it cannot tell stays (a `drills` folder may be another machine's on a NAS), with `kept what is left in <backups>/drills`, so an older record whose set was pruned may be left for you to delete. The counts are of sets.
- **Fixed in:** `v2.173.0`
- **Code:** `scripts/uninstall.sh` — `is_set`, `backup_sets`, `drill_is_mine`; `scripts/restore-drill.sh` — `write_record`

### Uninstall --backups keeps this install's own backup sets and says another install made them
- **Check:** `HATCHABOT_SECRET_KEY` in `.env` is a passphrase with a `$`, a quote or a `#` in it; `hatchabot uninstall --purge --backups` says "kept N sets another Hatchabot install made there", and those sets (and their `secret-key.env`) are still on disk.
- **Cause:** uninstall read `.env` one way, and the nightly backup got it another, so such a key gave two different owner fingerprints. On Linux the backup gets `.env` from systemd (no expansion; a `#` inside a value is kept), on a Mac from the launchd job, which sources it (a `$` expands), and by hand from Node's dotenv parser (a `#` starts a comment). Generated keys are not affected. The same difference could hide a `HATCHABOT_DB` or `HATCHABOT_BACKUP_DIR`: a hand-edited Mac `.env` with `$HOME/...` read as no database, and `--purge` removed `.env` and said the agents were gone while they ran on.
- **Fix:** upgrade, then run it again; `.env` is now read the way the service reads it on that machine, and a set made under Node's reading by a backup run by hand also counts as this install's. Without upgrading, delete those dated sets by hand if you are sure they are this install's.
- **Fixed in:** `v2.172.0`
- **Code:** `scripts/uninstall.sh` — `OWNER`, `ALT_OWNER`, `ENV_READ`, `ENV_ALT_KEY`; `scripts/backup-owner.sh` — `key_owner`; `scripts/launchd-plist.sh`

### After `uninstall.sh --purge`, a `restore-safety` folder is left in the backup folder, with an agent's whole volume in it
- **Check:** `ls <backup folder>` shows `restore-safety` or `restore-safety-<16 hex>` holding a `.tgz`, and the purge printed `kept <that folder>: a restore's safety copies`.
- **Cause:** a restore held, or one that could not be undone, keeps a copy that may be an agent's only good state. It is unencrypted and holds the agent's tokens. A purge without `--backups` keeps it. Even with `--backups`, a purge can only recognise this install's folder by its key: not a folder from before folders were per install, one made under an old key, or a second purge after the first removed `.env`.
- **Fix:** if you may still need the agent, restore from that copy first. Otherwise delete the folder, after checking it is not another install's, and rotate the tokens that agent held if the disk may have been read.
- **Fixed in:** —
- **Code:** `scripts/uninstall.sh` — `OWNER`; `scripts/backup-owner.sh` — `key_owner`; `src/orchestrator/backups.ts` — `restoreSafetyDir`

### After `uninstall.sh --purge`, a `move-copies` folder is left behind, with an agent's whole volume in it
- **Check:** `ls <data folder>` shows a `move-copies` folder holding a `.tgz` or `.tgz.part`, and the data folder stayed because it is not Hatchabot's own or is also the backup folder. The service was killed during a move (uninstall stopping it is one way).
- **Cause:** that copy is unencrypted and holds the agent's tokens. The only cleanups were in the running process and at its next boot, and after a purge there is no next boot. A purge that kept the data folder removed only the database.
- **Fix:** upgrade: any `--purge` removes that folder, with or without `--backups`. Otherwise delete it by hand, after checking no move is running, and rotate the tokens that agent held if the disk may have been read.
- **Fixed in:** `v2.172.0`
- **Code:** `scripts/uninstall.sh`; `src/orchestrator/backups.ts` — `newMoveCopy`, `sweepMoveCopies`
