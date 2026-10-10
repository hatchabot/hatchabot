# Releasing Hatchabot

## Versioning

- **Semantic versioning.** `MAJOR.MINOR.PATCH`: a feature bumps MINOR, a fix
  bumps PATCH, a change that needs operator action (env, units, data layout)
  bumps MAJOR. The CHANGELOG is the contract; "Upgrading" notes go at the top
  of the entry that needs them.
- **A tag is a release.** `vX.Y.Z` tags on `main` are the only things a user
  should install. `package.json` must carry the same version (the web app shows
  it at the bottom; the server stamps it at boot).
- **CHANGELOG.md is written with the change**, not at release time — every
  user-visible commit adds a line under the version it ships in.

## Branches

- `main` is the stable trunk: every commit on it is tested (CI runs typecheck,
  unit tests and the e2e suite) and deployable.
- Anything non-trivial goes on a branch and lands by pull request, so CI has run
  before it reaches `main`. Small fixes may go straight to `main` with a green
  local `npm test`.
- Protect `main` on GitHub: require the CI check and a linear history. (Settings
  → Branches → Add rule → `main`.)

## Channels — releasing fast without moving new users

A tag is a release, and **tagging makes a release `latest` — nothing more.**
New installs take **`stable`**, which names a release in `channels.json` on
`main` and moves only when you say so:

```sh
./scripts/promote.sh v2.31.0          # stable → v2.31.0
./scripts/promote.sh v2.32.0 beta     # beta   → v2.32.0
./scripts/channels.sh                  # where every channel points, and the releases
```

Promote from a `main` that matches `origin/main` exactly (it refuses
otherwise, so nothing unpushed rides along) and a tag on `main`. The commit
it pushes changes `channels.json` and nothing else: other staged or unstaged
work is left as it was, and it refuses before pushing if the commit would
hold anything more. Promoting
forward asks GitHub first: it refuses a release whose CI run for the push to
`main` failed
(naming the run), waits for one still running, and stops when there is no run
or no `gh` — `HATCHABOT_PROMOTE_IGNORE_CI=1` goes on without the check. Moving
a channel back (a rollback) is not held to it.

On the development machine the CLI has the release verbs too — set
`HATCHABOT_DEV_DIR=<your checkout>` in `~/.config/hatchabot/env` once:

```sh
hbt deploy           # this machine: the newest tag, now   (hbt deploy v2.31.3 for a specific one)
hbt promote          # stable ← what this machine runs     (hbt promote v2.32.0 beta)
hbt channels         # where everything points
```

It then refuses while a **live test** is due for the release
([live-tests.md](live-tests.md)): the tests that run against the real
install and machines, which CI cannot. Once the release runs on the
development machine:

```sh
node scripts/live.mjs due                         # what is due, and why
node scripts/live.mjs run runner-scenarios -- --runner "<name>"
node scripts/live.mjs run clean-install -- --ai-source "<an AI source name>"   # from nothing, on a fresh Linux VM (LXD)
git add docs/live-test-runs.md && git commit -m "Live tests: …" && git push
```

`HATCHABOT_PROMOTE_IGNORE_LIVE=1` promotes without them; a rollback is not
held to it.

The machine you develop on can run every release first, automatically:

```sh
./scripts/follow-latest.sh --install   # deploy the newest tag within 10 minutes of tagging
./scripts/follow-latest.sh --uninstall # back to deploying by hand
```

It deploys through `deploy-release.sh` (health check, automatic rollback). A tag
that fails is not retried; the next tag is. It never moves `stable` — so the
rhythm becomes: tag → it runs here → promote when it has held up.

Any other install can follow a channel on its own — a hosted tenant on
`stable`, a canary on `beta`:

```sh
./scripts/follow-channel.sh --install stable   # checks every 10 minutes (systemd --user)
./scripts/follow-channel.sh stable             # once, now
./scripts/follow-channel.sh --uninstall
```

It upgrades through `upgrade.sh` (forward only; the previous release restored if
the new one does not start). A release that failed is not retried until the
channel names a newer one. One whose install keeps failing (no network, a
lockfile npm refuses) is retried less and less often — 10 minutes, 20, 40 … —
and set aside after eight failures in a row; the service is never restarted
for an install that failed. So promoting is the rollout: every follower of that
channel moves within about ten minutes.

So the rhythm is: tag and deploy to your own machines as often as you like;
promote to `beta` when a release is worth testers' time; promote to `stable`
once it has run for a while without surprises. Rolling `stable` back is the
same command with an older tag (it asks first). CI checks that every tag
`channels.json` names exists. The installer remembers each machine's channel
(`~/.config/hatchabot/channel`), so re-running it upgrades along that channel.

The installer script is on that schedule too: hatchabot.com's `install.sh`
fetches it from the release `stable` names, not from `main`. A change to
`install.sh` reaches new users when you promote the release that carries it.

## Trying a newer OpenClaw

Build the candidate (Settings → Advanced → Runtime images, `hatchabot upgrade-image --candidate
--version X`, or `OPENCLAW_VERSION=X NO_LATEST=1 ./scripts/build-runtime-image.sh`
— 2026.8 and later come out engine-free and need the shared memory search
service running), then run the gate on the host:

```sh
scripts/candidate-gate.sh hatchabot-runtime:X      # or: npm run gate:candidate -- hatchabot-runtime:X
```

It makes a throwaway web-only agent, pins it to the candidate, and checks
everything Hatchabot reads or writes of OpenClaw's own formats (config accepted
by `openclaw doctor`, memory index + semantic search, the CLI JSON shapes, the
files it reads, the console address — and the console loaded through
Hatchabot's proxy the way a browser loads it, since 2026.9.6 answered the
address and still showed "Control UI did not start" — one real model turn),
then deletes the agent. `hatchabot console <agent> --check` runs that last
check on any agent. Only a candidate that passes is tried on one real agent
(`hatchabot image try "<agent>" hatchabot-runtime:X`), then promoted. The
management agent stays pinned and moves last.

## Cutting a release

1. `npm test && npm run typecheck && npm run test:ui` green on `main` (the last one drives the real page in headless Chrome, in docker: scripts/ui-clickthrough.mjs), and
   **`./scripts/upgrade-check.sh`** — it builds a database with each of a few
   past releases' own code and opens it with this build, which is the only way
   to catch a column added to an existing table with no `ALTER` (every unit
   test starts from a fresh database, where `CREATE TABLE` runs in full). CI
   runs it too. `npx tsx scripts/schema-drift.ts` does the same against a live
   install's database.
   Then **`node scripts/privacy-check.mjs --sync-ci`**: GitHub's copy of
   the privacy fingerprints, current before the release's commits and notes
   reach it (the daily timer does it too; below).
2. Bump `version` in `package.json` and finish the CHANGELOG section
   (`## [X.Y.Z] — YYYY-MM-DD`).
   **Does it change how containers are made** (docker run flags, mounts,
   network, what the seed writes) so that existing agents should be remade?
   Append one entry to `SETUP_CHANGES` in `src/orchestrator/rebuildPolicy.ts`:
   the next `gen`, this version, a level and a reason ("its mounts were
   tightened"). `required` means every install rebuilds its agents on its
   own, once each is idle (unless its owner chose manual); `recommended`
   badges them, and rebuilds them overnight on installs set to `auto`;
   `optional` only rides along with the next rebuild. Never edit or remove
   an entry: containers carry the number. A new runtime image needs no entry;
   agents behind the default image are already `recommended`.
3. Commit, land, tag:
   ```sh
   git commit -am "Release vX.Y.Z"
   scripts/land.sh                        # a pull request; merges when its checks pass
   git tag vX.Y.Z && git push origin vX.Y.Z   # the tag on what landed
   ```
   `main` takes changes only through a pull request whose required checks
   pass (test, ui, secrets, upgrade, privacy); `scripts/land.sh` opens it,
   asks for a rebase merge, waits, and brings local `main` to what landed.
   There is no bypass: in an emergency the repository owner turns the `main`
   rule off in GitHub's settings, pushes, and turns it back on.
   Push the one tag by name, never `--tags`: a checkout can hold tags that
   must not be public (the pre-1.0 history's `v0.*` tags reached GitHub that
   way, found 2026-10-09). The privacy check's hook refuses such a push.
4. Create the GitHub Release with the CHANGELOG section as its notes, after
   checking them — the notes are published apart from the code, so the push
   hook never sees them:
   ```sh
   awk '/^## \[X.Y.Z\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md > notes.md
   node scripts/privacy-check.mjs --text notes.md && gh release create vX.Y.Z -F notes.md -t vX.Y.Z
   ```
5. Deploy it (below).

## The privacy check

The repository is public. `scripts/privacy-check.mjs` keeps this household's
private values out of it: every agent's name and slug, people's names, ids and
emails, bot usernames, machine, tailnet and IP names, and the secret values in
`.env`. It reads them from the live install each time it runs (the script and
`scripts/privacy-ignore.txt` hold nothing private) and prints a hit masked.
A pattern scanner cannot do this: a real agent's name is just words.

- **Every push** from a clone with the hook (`node scripts/privacy-check.mjs
  --install-hook`, once per clone; `--check-hook` says whether this clone's
  pre-push runs it, including through a machine-wide `core.hooksPath` that
  hands on to the repo's own hook) checks the lines, file names, branch and
  tag names, authors, committers, taggers and messages being published, and
  refuses a `v0.*` tag or a tag off `main`. On a machine with no install at
  all it warns and lets the push through; an install it can only partly read
  (an env file but no database, say) blocks the push.
- **Every release note**, with `--text` (step 4 above).
- **Every pull request and push to `main`, on GitHub**: CI's `privacy` job
  (below) — whoever or whatever wrote the change, on any machine or on
  GitHub's own pages. With `main` behind pull requests it is a required
  check.
- **Every day, on GitHub**: the `Privacy watch` workflow reads what is
  published beside the code (below).
- **Every promote**: the `privacy` live test (`--public --check-hook`) reads
  everything GitHub serves, so a push from another machine, a web edit or a
  merged pull request is caught before `stable` moves; it also fails when the
  checkout it runs from has no hook.

Each run ends in one of three results, and says which:

| Exit | Result | Meaning |
|---|---|---|
| 0 | clean | nothing it checked names a private value |
| 1 | found | a private value (printed masked), or a refused tag |
| 3 | incomplete | something it needed could not be read: the database, an env file, a note file, or GitHub's release notes and issues (`gh` missing, signed out, refused). Never a pass: the live test records it as a fail and `--text … &&` stops the release |

Every result also says what is **not covered**: binary files and images (no
OCR), and, with `--no-machine` or no `tailscale` command, this machine's
names. `--public` always prints how many accepted historical commits it left
out (below). The clone's own git identity (`user.name`, `user.email`) and
the identities in `scripts/privacy-identity.txt` (the maintainer's author
name and addresses, already public on every commit) are not findings as an
author or committer or in a `Co-authored-by`/`Signed-off-by` trailer — a
squash merge on GitHub adds one — but the same value in a file or anywhere
else in a message is. A line of that file counts only while a commit on
`main` already carries that exact identity, so adding a line cannot allow a
private name.

### On GitHub: keyed fingerprints

GitHub never gets the private values. What it holds, in the repository
secret `PRIVACY_FINGERPRINTS`, is a **keyed fingerprint** of each:
HMAC-SHA256 over the value's words, with a key made once on this machine
(`~/.config/hatchabot/privacy-ci.key`, 0600), plus that key, each
fingerprint's kind (agent name, email, …) and the word counts to try. A
fingerprint cannot be turned back into a name, but anyone with the whole
secret can test guesses against it, so it is kept as a secret.

- **`node scripts/privacy-check.mjs --sync-ci`** makes the set from this
  install and sets the secret with `gh secret set` (the value on stdin,
  never in a command line; it prints counts only). It refuses, exit 3, an
  install it cannot fully read — the same rule as the hook.
  `--export-digests --out <file>` writes the same set to a 0600 file.
- **Daily**: `scripts/privacy-sync.sh --install` (Linux, a systemd user
  timer) runs it once a day, so a new agent's name is covered within a day;
  `scripts/privacy-sync.sh --uninstall` stops it. On a Mac there is no
  timer: run the command after adding an agent or a person, and before each
  release (step 1 above).
- **CI's `privacy` job** (`.github/workflows/ci.yml`, `scripts/privacy-ci.mjs`)
  splits into words — letters and digits, with `. @ - _` kept inside a word,
  and each joined word's parts tried as well (so a slug inside a file name
  is found) — every added line of a pull request (`base...head`) or a push
  to `main` (`before..after`), every changed file's path, each commit's
  message, author and committer, and the pull request's title, body and
  branch name; it fingerprints every run of words of a length some value has
  and fails on a match. A hit prints the kind, a masked hint (`'Ma…(16)'`)
  and where — `file:line`, `commit message <sha>`, `PR body` — never the
  value. Names keep their case as here; slugs, emails, machine names and ids
  match in any case. The scanner is taken from the base commit, so a change
  cannot loosen the check it is judged by.
- **`Privacy watch`** (`.github/workflows/privacy-watch.yml`, daily and by
  hand) reads the last two days of issues, pull request titles and bodies,
  issue comments, review comments and release notes with a read-only token,
  and fails on a match; GitHub then emails the owner.
- **No secret is a failure**, never a pass (exit 3): a pull request from a
  fork gets no secrets, so its `privacy` check fails until the maintainer
  re-makes it on a branch here. A garbled secret, or a range that is not in
  the checkout, is exit 3 too.

What it cannot catch: a private value the install has no record of (a
person mentioned only in conversation, say); a paraphrase or a misspelling;
a name broken across two lines (text is read a line at a time); images and
other binary files; review summaries, discussions and the wiki; anything the
watch's two days have passed. The rule in `AGENTS.md` — examples come from
the invented household — stays the first line of defence.

A hit: replace the value with a made-up one — examples come from the invented
household in `docs/deck/shot-data.mjs`. A generic word that is only by chance
an agent's name ("Test") goes in `scripts/privacy-ignore.txt`.

### Retained history

The history published up to the 2026-10-09 scrub (`ACCEPTED_HISTORY` in
`scripts/privacy-check.mjs`, commit `4dfbb0f`) still names real agents and
other household values. Keeping it, not rewriting it, is the maintainer's
deliberate decision (2026-10-09, issue #40), not an oversight: `--public`
checks main's files as they are now and everything after that commit, and
reports the commits before it separately ("N accepted historical commits not
checked (retained by decision, docs/releasing.md)") instead of calling the
whole repository clean. Removing that history would need an explicit,
authorized plan first — an inventory of every branch, tag, release, pull
request ref and cache that holds it, then a destructive rewrite — and even
then it cannot reach copies outside this repository, such as the existing
fork or anyone's clone.

GitHub's side: secret scanning and push protection are on; rulesets refuse
force-pushes and deletion of `main`, `v0.*` tags, and moving or deleting a
release tag; CI runs gitleaks on every push and pull request. Its exceptions
(`.gitleaks.toml`) are exact fixture values, each for one rule and only in the
files that hold it — never a word list, which let a setting's name hide a
real-looking value (#42). A new fixture that trips it gets its exact value
added there; `scripts/gitleaks-regression.sh` (run by the same CI job) checks
that ordinary values are still reported whatever they are called.

## Updating pinned actions and images

Every `uses:` in `.github/workflows/` names a full commit SHA with its
release as a comment (`actions/checkout@<sha> # v7.0.1`), and the base
images name a digest (`node:24-slim@sha256:…`). A tag can be moved by
whoever controls it; a SHA or digest cannot. The jobs that build run with a
read-only token; only the small jobs that upload (`attach` in bundles.yml,
`publish` in runtime-image.yml) can write, and they run no project code.
`test/workflowPins.test.ts` fails CI when a `uses:` is not a SHA, a checkout
keeps its git credentials, a job that installs or builds can write, or an
image pin is missing.

- **The reviewed path:** Dependabot (`.github/dependabot.yml`) opens a
  weekly pull request for actions and for the `FROM` lines in `docker/`. Read
  the upstream release notes, let CI pass, merge.
- **What Dependabot does not see:** `ARG NODE_IMAGE=` in
  `docker/Dockerfile.runtime` and `CHROME_IMAGE` in
  `scripts/ui-clickthrough.mjs` (with the matching `docker pull` in
  `ci.yml`). Bump those by hand, as below.
- **By hand (and the emergency path, when an action or image must move
  today):** check the upstream release (its notes, and that the tag belongs
  to the project's own repository), then resolve it yourself:
  ```sh
  gh api repos/<owner>/<action>/git/ref/tags/<tag>   # type "tag"? then:
  gh api repos/<owner>/<action>/git/tags/<sha>       # .object.sha is the commit
  docker buildx imagetools inspect <image>:<tag>     # the index "Digest:", not one platform's
  ```
  Replace the SHA (and its comment) or digest, run the gates, and release as
  usual. A new runtime base image is a new image: build a candidate first
  (Trying a newer OpenClaw, above).

## Deploying — run releases, not the working tree

A production Hatchabot should run from a **checkout pinned to a tag**, not
from the directory you develop in. The server reads `web/index.html` from disk
on every request and runs TypeScript straight from `src/` via `tsx`, so an
edit — or a half-finished `git pull` — in a live checkout changes what users see
*immediately*. Keep them apart:

```
~/hatchabot        # development: branches, uncommitted work, tests
~/hatchabot-prod   # production: always at a tag; nothing edited by hand
~/hatchabot-data   # state: SQLite (which also holds the encrypted secrets), backups
```

Point the service at the production checkout and the data directory:

```ini
# ~/.config/systemd/user/hatchabot.service
WorkingDirectory=%h/hatchabot-prod
EnvironmentFile=%h/hatchabot-prod/.env
ExecStart=%h/hatchabot-prod/node_modules/.bin/tsx src/index.ts
```
and in `.env`: `HATCHABOT_DB=/home/<you>/hatchabot-data/hatchabot.sqlite`.
Backups already default to `~/hatchabot-backups` (`HATCHABOT_BACKUP_DIR`), outside
any checkout; core-file snapshots are stored in the database.

Then a deploy is one command — `scripts/deploy-release.sh vX.Y.Z` — which
fetches tags, checks the tag out in the production directory, runs `npm ci`,
restarts the service and waits for the new version to be served. Rolling back
is the same command with the previous tag.

## Before going public — one-time hygiene

- Rewrite history if it ever contained personal data (see the audit notes);
  scan with `git log --all -S '<string>'` before the first public push.
- Confirm `.env`, `data/` and `*.sqlite` are ignored (they are) and that no
  fixture in `test/` or `docs/` names real people or real identifiers.
- Fill in the contact address in SECURITY.md.

## Renamed install (AgentClaw → Hatchabot, pre-1.0 hosts)

- **Linux / systemd:** `scripts/migrate-rename-host.sh vX.Y.Z --yes [--old <dir>]`
  from the new checkout (see the script header). Re-runnable; nothing deleted.
- **macOS / launchd:** there is no script. Do it by hand, in this order:
  `launchctl unload ~/Library/LaunchAgents/com.agentclaw.*.plist`; clone the
  Hatchabot repo beside the old checkout and `npm ci`; copy `.env`/`.env.mgmt`
  across, renaming `AGENTCLAW_*` keys to `HATCHABOT_*` (values unchanged);
  set `HATCHABOT_DB` to where your `agentclaw.sqlite` lives (or move it and
  point at the new place); `docker tag agentclaw-runtime:latest
  hatchabot-runtime:latest`; install the new plists from `deploy/` and load
  them. The old checkout can stay until you're happy.
- **In-place `git pull` (no script):** works — `AGENTCLAW_*` env is aliased,
  the old DB/backup paths are found when the new ones don't exist, and old
  containers, tokens and export files are recognised. You keep the old unit
  and directory names until you migrate.
