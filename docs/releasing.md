# Releasing Hatchabot

## Versioning

- **Semantic versioning, still 0.x.** `0.MINOR.PATCH`: a feature bumps MINOR, a
  fix bumps PATCH. Until 1.0, a MINOR bump may change behaviour; the CHANGELOG
  is the contract.
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

## Cutting a release

1. `npm test && npm run typecheck` green on `main`.
2. Bump `version` in `package.json` and finish the CHANGELOG section
   (`## [X.Y.Z] — YYYY-MM-DD`).
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
