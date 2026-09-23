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

On the development machine the CLI has the release verbs too — set
`HATCHABOT_DEV_DIR=<your checkout>` in `~/.config/hatchabot/env` once:

```sh
hbt deploy           # this machine: the newest tag, now   (hbt deploy v2.31.3 for a specific one)
hbt promote          # stable ← what this machine runs     (hbt promote v2.32.0 beta)
hbt channels         # where everything points
```

Before promoting to `stable`, install it from nothing on a fresh Linux VM —
the only test that starts where a newcomer does (it needs LXD):

```sh
scripts/clean-install-test.sh --ai-source "<an AI source name>"
```

The machine you develop on can run every release first, automatically:

```sh
./scripts/follow-latest.sh --install   # deploy the newest tag within 10 minutes of tagging
./scripts/follow-latest.sh --uninstall # back to deploying by hand
```

It deploys through `deploy-release.sh` (health check, automatic rollback). A tag
that fails is not retried; the next tag is. It never moves `stable` — so the
rhythm becomes: tag → it runs here → promote when it has held up.

So the rhythm is: tag and deploy to your own machines as often as you like;
promote to `beta` when a release is worth testers' time; promote to `stable`
once it has run for a while without surprises. Rolling `stable` back is the
same command with an older tag (it asks first). CI checks that every tag
`channels.json` names exists. The installer remembers each machine's channel
(`~/.config/hatchabot/channel`), so re-running it upgrades along that channel.

The installer script is on that schedule too: hatchabot.com's `install.sh`
fetches it from the release `stable` names, not from `main`. A change to
`install.sh` reaches new users when you promote the release that carries it.

## Cutting a release

1. `npm test && npm run typecheck` green on `main`, and
   **`./scripts/upgrade-check.sh`** — it builds a database with each of a few
   past releases' own code and opens it with this build, which is the only way
   to catch a column added to an existing table with no `ALTER` (every unit
   test starts from a fresh database, where `CREATE TABLE` runs in full). CI
   runs it too. `npx tsx scripts/schema-drift.ts` does the same against a live
   install's database.
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
3. Commit, tag, push:
   ```sh
   git commit -am "Release vX.Y.Z"
   git tag vX.Y.Z && git push origin main --tags
   ```
4. Create the GitHub Release from the tag with the CHANGELOG section as its
   notes: `gh release create vX.Y.Z --notes-from-tag` (or paste).
5. Deploy it (below).

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
