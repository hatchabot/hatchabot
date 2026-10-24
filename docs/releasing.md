# Releasing Hatchabot

## Versioning

- **Semantic versioning.** `MAJOR.MINOR.PATCH`: a feature bumps MINOR, a fix
  bumps PATCH, a change that needs operator action (env, units, data layout)
  bumps MAJOR. The CHANGELOG is the contract; "Upgrading" notes go at the top
  of the entry that needs them.
- **A tag is a release.** `vX.Y.Z` tags on `main` are the only things a user
  should install. They are made in the private dev repo and reach the public
  repo only through the publisher (below, "How a release reaches the public
  repo"). `package.json` must carry the same version (the web app shows it
  at the bottom; the server stamps it at boot).
- **CHANGELOG.md is written with the change**, not at release time — every
  user-visible commit adds a line under the version it ships in.

## Branches

- Work happens in the private dev repo `cksci/hatchabot-dev` (every clone's
  `origin`). The public repo `hatchabot/hatchabot` is the remote `public`,
  read only (push `DISABLED`): it changes only through the publisher.
- `main` is the stable trunk: every commit on it is tested (CI runs typecheck,
  unit tests and the e2e suite) and deployable.
- Every change lands by pull request (`scripts/land.sh`), so CI has run
  before it reaches `main`: it waits for every check (test, ui, secrets,
  upgrade, kit-checks) and merges with a rebase. The dev repo has no branch
  rules, so `land.sh` is the gate; nothing else pushes to `main`.

## The kit checks (known vulnerable pins, unsafe code patterns)

The publish kit's dependency and code checks (publish-kit SPEC.md section
14) run on every pull request as the `kit-checks` job
(`.github/workflows/kit-checks.yml`, dev repo only) and in `kit preflight`
before a tag: `osv-scanner` over `package-lock.json`, and `opengrep` with the
kit's security rules over the tree. Every hit blocks. Locally:

```sh
python3 -I scripts/kit_checks.py      # fetches the pinned tools once into ~/.cache/publish-kit/checks
```

`scripts/kit_checks.py` is an unchanged copy of the kit's
`checks/kit_checks.py` (`kit doctor` compares the two; a new kit release
means copying it again). Fix a hit rather than except it; an exception in
`kit-checks.toml` names one advisory id and lock file, or one rule and path,
with a reason and an expiry date, and is published with the file, so its
reason carries no private values. `nosemgrep` comments and `.semgrepignore`
files are not honoured.

## How a release reaches the public repo

The publish kit (`cksci/publish-kit`) runs it, from the private
`cksci/publisher` repo:

1. `scripts/release.sh X.Y.Z` tags the version commit in the dev repo (an
   annotated `vX.Y.Z`, pushed by name).
2. The publisher picks the tag up on its next run (scheduled runs come
   hours apart; `gh workflow run publish.yml -R cksci/publisher`, or Actions
   → publish → Run workflow in the browser, starts one). Its gate scans
   everything that would become public — every file, the text inside binary
   files, the release notes — against keyed fingerprints of this
   household's private values (from `scripts/private-values`, below),
   generic personal-data patterns and gitleaks.
3. A clean gate opens a digest issue in `cksci/publisher`
   (`hatchabot vX.Y.Z publishes at <time>`: the notes, the changed public
   text). Skim it. To stop this release, add the label `reject`; to stop
   everything, set the publisher's `HOLD` variable.
4. After 1 hour, the gate runs again with a fresh set, then the publisher
   pushes one commit (`Release vX.Y.Z`: the tag's files, the maintainer's
   name with the GitHub noreply address) and the annotated tag to the
   public repo. Only its deploy key may (the `kit-main` and `kit-tags`
   rulesets).
5. The tag push starts the public repo's `release.yml` (below), which
   builds, attests and publishes the GitHub release. Then it is `latest`.

A gate hit opens an issue in `cksci/publisher` (rule, path, line and
fingerprint id; never the value). A blocked tag is final: fix it and
release the next patch version. A moved dev tag cancels its release.

Never published (`publish.toml` `exclude`): `publish.toml`,
`.github/dependabot.yml` (Dependabot runs in the dev repo) and the provider
`scripts/private-values`.

## Channels — releasing fast without moving new users

A tag is a release, and **releasing makes it `latest` — nothing more**
(the newest release also moves the runtime image's `:latest`).
New installs take **`stable`**, which names a release in `channels.json` on
`main` and moves only when you say so:

```sh
./scripts/promote.sh v2.31.0          # stable → v2.31.0
./scripts/promote.sh v2.32.0 beta     # beta   → v2.32.0
./scripts/channels.sh                  # where every channel points, and the releases
```

Promote from a `main` that matches `origin/main` exactly (it refuses
otherwise, so nothing unpushed rides along) and a published release: the
public repo must have its tag, and its GitHub release must be published
(not a draft) with `release-manifest.json` (v2.159.0 and later) — a tag
whose release workflow failed or is still running is refused. It also
refuses while a release tagged in the dev repo but not published yet has a
`channels.json` naming another release for the channel: the publisher
publishes that tag's whole tree, which would put the channel back
(`HATCHABOT_PROMOTE_IGNORE_PENDING=1` goes on regardless; promote once it
is published instead). The commit it lands changes `channels.json`
and nothing else: other staged or unstaged work is left as it was, and it
refuses before pushing if the commit would hold anything more. Promoting
forward asks GitHub first: it refuses a release whose CI run for the push to
`main` failed (the dev repo's; for a release from before the dev repo, the
public repo's), naming the run, waits for one still running, and stops when
there is no run or no `gh` — `HATCHABOT_PROMOTE_IGNORE_CI=1` goes on without
the check. Moving a channel back (a rollback) is not held to it.

Once the channel's commit has landed on the dev repo's `main`, it asks the
publisher for the fast lane: a tag `channels-<UTC time>` on that commit. On
its next run the publisher gates it, checks every release `channels.json`
names is published, and copies that one file to the public repo
(`Update channels`; no wait, no digest). That push starts the public repo's
`.github/workflows/promote-images.yml`, which moves the runtime image's
`:stable` or `:beta` to that release's image — by the digest in its
`release-manifest.json`, one alias at a time; a channel moved back by the
fast lane is a rollback (the tag states it, `rollback <channel> <from> →
<to>`, which promote.sh writes and the publisher's gate requires), so its
image moves back too. Any other push that moves a channel back (a release
tagged before a promote) fails and moves nothing, as does a channel naming
a tag with no published release. A release made before the release
workflow (older than v2.159.0) has no manifest: its image tags are left as
they are. A failed move can be made by hand: Actions → Promote images → Run
workflow.

When `land.sh` stops waiting (exit 3) its pull request stays open and
merges later; promote.sh then exits 3 too and says so. Once it has merged,
`git pull --rebase` and run the same `promote.sh` again: it finds the
channel already on `main` and asks for the fast lane. Run again after a
channel came back on the public repo (a release that carried an older
`channels.json`), it asks the publisher once more.

The publisher takes fast-lane tags in order, and holds each to the file the
one before it left. So while an earlier fast-lane tag asking for another
`channels.json` is still waiting, promote.sh asks for none: its rollback
line would be worked out against the wrong file, and the gate would refuse
it. Run it again once the earlier one has reached the public repo (to go
sooner: `gh workflow run publish.yml -R cksci/publisher`). It refuses before
the promote commit lands, so nothing reaches main meanwhile. Each tag the
publisher publishes is an "Update channels" commit on the public repo dated
with the tag's own date, so promote.sh finds which tags are published:
every tag dated up to the newest published one is done (before it, one the
publisher's gate blocked is never published), and every later one is
waiting unless its file is the public repo's now. A tag with no
`channels.json` (one made by hand) stops the publisher, so it counts as
waiting too. Rolling back both channels asks for two files, and the second
waits for the first. A blocked tag that is still
the newest is deleted from origin (`git push origin
:refs/tags/channels-…`) to go on. `HATCHABOT_PROMOTE_IGNORE_WAITING=1` goes
on regardless; it leaves the waiting-release check above in place. The same wait
holds `release.sh` back: a commit that already has a rollback in it, but
whose fast lane has not reached the public repo yet, is refused until it has.
Only `vX.Y.Z` tags count as waiting releases: the publisher never
publishes a pre-release tag, so `release.sh` refuses to make one.

On the development machine the CLI has the release verbs too — set
`HATCHABOT_DEV_DIR=<your checkout>` in `~/.config/hatchabot/env` once:

```sh
hbt release 2.32.0   # tag it in the dev repo; the publisher publishes it (scripts/release.sh)
hbt deploy           # this machine: the newest published tag, now   (hbt deploy v2.31.3 for a specific one)
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
./scripts/follow-latest.sh --install   # deploy the newest release within 10 minutes of its publishing
./scripts/follow-latest.sh --uninstall # back to deploying by hand
```

It deploys through `deploy-release.sh` (health check, automatic rollback). A tag
that fails is not retried; the next tag is. Before any of a tag's code runs
(v2.159.0 and later), the tag must be a published, immutable GitHub release
whose `release-manifest.json` is for that tag and names the tag's commit
(read without a token from `api.github.com`). A mismatch sets the tag aside;
one not published yet is looked at again, less and less often, then set aside. It never moves `stable` — so the
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
3. Commit and land the version commit:
   ```sh
   git commit -am "Release vX.Y.Z"
   scripts/land.sh                        # a pull request; merges when its checks pass
   ```
   `scripts/land.sh` opens the pull request in the dev repo, waits for its
   checks (test, ui, secrets, upgrade), merges it with a rebase, and brings
   local `main` to what landed.
4. Tag it — the publisher publishes it, and GitHub builds the release;
   nothing is built or uploaded from this machine:
   ```sh
   scripts/release.sh X.Y.Z               # or: hbt release X.Y.Z
   ```
   It refuses unless local `main` is `origin/main` and the version commit is
   on it (`package.json` says X.Y.Z, CHANGELOG has `## [X.Y.Z]`), CI passed
   on that commit's push to `main` (it waits for a run still going), and the
   tag `vX.Y.Z` exists neither in the dev repo nor on the public repo (a
   name the public repo ever had is used for good), and the commit's
   `channels.json` names no channel an older release than the dev repo's
   or the public repo's `main` does (its whole tree is published, so it
   would put the channel back). It checks the release
   notes (the CHANGELOG section) with `privacy-check.mjs --text`, brings the
   public repo's privacy fingerprints up to date (`--sync-ci`), then makes
   the annotated tag and pushes it, by name, to the dev repo.
   `--commit <sha>` tags an earlier commit on `main` instead of its head.
   Then the publisher (above, "How a release reaches the public repo"):
   skim the digest issue; the release is public an hour or more later.
5. Deploy it once it is published (below), then promote it when it has held
   up (above).

### What the release workflow does

`.github/workflows/release.yml` (started on the public repo by the
publisher's push of the tag `vX.Y.Z`; never in the dev repo; one run per
tag, so a release tagged soon after another waits for nothing and is never
cancelled):

1. **check** (read-only): `scripts/release-check.sh --tagged` — the tag
   names a commit on `main`, and `package.json` and CHANGELOG there say the
   version — and the notes against the privacy fingerprints
   (`privacy-ci.mjs --text`; no fingerprints fails).
2. **bundles** and **image** (read-only, nothing pushed): the three bundles
   with their `.sha256` (`bundles.yml`), and the multi-arch runtime image as
   OCI archives with its index made in advance (`runtime-image-build.yml`,
   `scripts/oci-index.mjs`), its labels checked (the Dockerfile's OpenClaw,
   this release).
3. **manifest** (read-only): `release-manifest.json`
   (`scripts/release-manifest.mjs`) — version, commit, each asset's name,
   size and sha256, the image's index and per-arch digests, the OpenClaw
   version (the released commit's `ARG OPENCLAW_VERSION`) and base image.
4. **attest**: a GitHub build-provenance attestation over the bundles, their
   `.sha256` files and the manifest, then `gh attestation verify` on each.
   Anyone can check a download the same way:
   `gh attestation verify <file> --repo hatchabot/hatchabot`.
5. **publish** (the one job that can write; it runs no project code): the
   image pushed by its index digest and tagged `:vX.Y.Z` (refused if that tag
   names another digest), a **draft** release with the notes, every bundle,
   `.sha256` and the manifest, the draft's asset list checked against the
   manifest (names, sizes, digests), then — the tag checked to name that
   commit — the release published.
6. **latest**: when it is the newest release — asked again as **publish**
   publishes it, since another tag's run may have come meanwhile — `:latest`
   moves to its image (`promote-images.yml`). `:beta` and `:stable` move only when
   `scripts/promote.sh` moves the channel; nothing else moves them, and never
   to an older release unless it is a rollback.

A failure before **publish** changes nothing on GitHub but the tag the
publisher pushed. Inside it, the worst left behind is a draft (the next
attempt deletes it) or an image pushed by digest with no tag. Fix the cause
and re-run the failed jobs (Actions → the run → Re-run failed jobs): they
use the same artifacts. A cause in the code itself is fixed by the next
patch version: the tag is published, and release tags never move.

There is no dry run of the release workflow: it runs only on the public
repo, once the tag is published. `bundles.yml` can be started by hand in
the dev repo to build the bundles (artifacts only, nothing published).

### Emergencies

- **Stop a release:** add the label `reject` to its digest issue in
  `cksci/publisher`, or set the publisher's `HOLD` variable (`all`, or
  `hatchabot`) to stop everything until it is cleared.
- **A broken `main` that blocks every pull request:** fix it in a pull
  request whose checks pass; the dev repo has no rule to turn off.
- **GitHub Actions is down:** wait. A release is made only by the publisher
  and the workflow; `scripts/release.sh` has no local path.
- **A bad release:** release a new patch version. `scripts/promote.sh` with
  an older tag rolls a channel (and its image alias) back. A bad release is
  not edited.
- **Something private leaked into a release:** set the publisher's `HOLD`
  first, so nothing more goes out.
  - *In the release notes:* edit them. An immutable release's title and notes
    stay editable; only its files and tag are locked.
  - *In code that shipped:* delete the release (an immutable release can be
    deleted, and its bundles go with it), turn the "release tags: never moved
    or deleted" rule off, delete the tag, rewrite the public history with the
    kit's rulesets off as for any history scrub (rulesets backed up first),
    turn them back on, `kit accept-public hatchabot <sha>` the new `main`,
    and release the next patch version. That version number is gone for
    good: GitHub never lets an immutable release's tag name be used again.
    Cached copies of the old commits are removed by GitHub Support, as
    before. Then add the value to what `scripts/private-values` reads, so
    the gate finds it next time.

### The repositories' settings

The public repo `hatchabot/hatchabot`:
- `kit-main` and `kit-tags` (the publish kit's rulesets): only the
  publisher's deploy key may update `main` or create `v*` tags;
- `main`: no force-push or deletion; `v*` tags: never moved or deleted;
  `v0.*` never created;
- immutable releases on (since 2026-10-10); secret scanning and push
  protection on; one deploy key, the publisher's;
- the `release` environment (the publish job's): deployable from release
  tags (`v*.*.*`) only;
- one Actions secret, `PRIVACY_FINGERPRINTS` (CI's `privacy` job and the
  privacy watch).

`kit doctor hatchabot` (in the publish kit) checks all of these. The dev
repo `cksci/hatchabot-dev` is private, with no branch rules (`land.sh`
lands every change), and its own CI runners on the main machine: every
job runs there, `ui` too, with rootless podman for its Chrome container
(the publish kit's `runner/containers.sh`), so dev CI spends no Actions
minutes. The public repo's CI runs on GitHub's runners.

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
- **Every release, before it is public**: the publisher's gate, twice
  (above, "How a release reaches the public repo"), with keyed fingerprints
  of the same values from `scripts/private-values`: `node
  scripts/privacy-check.mjs --export-values` (only into a pipe) and the
  machine's `~/.config/pii-scan/private.json`, less what is public by
  decision. `kit values sync hatchabot` uploads them to the publisher.
- **Every push to the public repo's `main`, on GitHub**: CI's `privacy` job
  (below), after the fact: the dev repo holds no fingerprint set, so the job
  runs on the public repo only.
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

Every result also says what is **not covered**: pictures and compressed data
inside binary files (no OCR, no unpacking), and, with `--no-machine` or no `tailscale` command, this machine's
names. The text inside a file git treats as binary (a name in a PDF's or a
photo's metadata, a SQLite file) is read, as UTF-8 and UTF-16, since
2026-10-10, and by the GitHub-side `privacy` job too since v2.162.0: each
run of text is split into words like a line and looked up the same way.
`--public` always prints how many accepted historical commits it left
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
  never in a command line; it prints counts only) on the public repo (the
  remote `public`). It uses the token in `~/.config/hatchabot/secrets.token`
  when there is one (a fine-grained token that can only write the public
  repos' Actions and Dependabot secrets; the everyday token cannot), else
  gh's own login. It refuses, exit 3, an install it cannot fully read — the
  same rule as the hook.
  `--export-digests --out <file>` writes the same set to a 0600 file.
- **Daily**: `scripts/privacy-sync.sh --install` (Linux, a systemd user
  timer) runs it once a day, so a new agent's name is covered within a day;
  `scripts/privacy-sync.sh --uninstall` stops it. `--install --also
  owner/name` (repeatable) syncs another repository too: the project's
  website runs the same check on GitHub (its own `privacy` workflow, the
  scanner fetched from a release tag and checked by sha256) and a pre-push
  hook that calls this clone's script. On a Mac there is no
  timer: run the command after adding an agent or a person, and before each
  release (step 1 above).
- **CI's `privacy` job** (`.github/workflows/ci.yml`, `scripts/privacy-ci.mjs`)
  splits into words — letters and digits, with `. @ - _` kept inside a word,
  and each joined word's parts tried as well (so a slug inside a file name
  is found) — every added line of a pull request (`base...head`) or a push
  to `main` (`before..after`), the text inside every changed binary file
  (runs of six or more characters, as UTF-8 and UTF-16) and every changed
  file's path — in the end result and in each commit on its own, since a
  value added and taken out again is still public in the history (`file
  (commit <sha>):line`; at most 1,000 commits, more is exit 3) — each
  commit's message, author and committer, and the pull request's title, body and
  branch name; it fingerprints every run of words of a length some value has
  and fails on a match. A hit prints the kind, a masked hint (`'Ma…(16)'`)
  and where — `file:line`, `commit message <sha>`, `PR body` — never the
  value. Names keep their case as here; slugs, emails, machine names and ids
  match in any case. The scanner is taken from the base commit, so a change
  cannot loosen the check it is judged by.
- **`Privacy watch`** (`.github/workflows/privacy-watch.yml`, daily and by
  hand) reads the last two days of issues, pull request titles and bodies,
  issue comments and review comments, and every release note (GitHub gives
  a release no date it was last edited, so notes edited on an old release
  are read too), with a read-only token, and fails on a match; GitHub then
  emails the owner.
- **No secret is a failure**, never a pass (exit 3): a pull request from a
  fork gets no secrets, so its `privacy` check fails until the maintainer
  re-makes it on a branch here. A garbled secret, a range that is not in
  the checkout, or a git command that fails, is exit 3 too.

What it cannot catch: a private value the install has no record of (a
person mentioned only in conversation, say); a paraphrase or a misspelling;
a name broken across more than one line break (a name wrapped onto the
next line is found, as the publisher's gate finds it); pictures
and compressed data inside binary files (no OCR, no unpacking); review summaries, discussions and the wiki; an issue,
pull request or comment the watch's two days have passed. The rule in `AGENTS.md` — examples come from
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
release tag; CI runs gitleaks on every push and pull request, then over the
whole tree as the publisher's gate does: default rules, no config. The gate
ignores `.gitleaks.toml`, so it allows nothing either: an exception there
would pass CI and block the release, as sample values in the tests blocked
v2.164.0. A test or page that needs a credential-shaped sample builds it at
run time (`test/support/fixtures.ts`). `scripts/gitleaks-regression.sh` (run
by the same CI job) checks that ordinary values are reported whatever they
are called (an old word-list allowlist hid them, #42), and the old samples
wherever they are.

## Updating pinned actions and images

Every `uses:` in `.github/workflows/` names a full commit SHA with its
release as a comment (`actions/checkout@<sha> # v7.0.1`), and the base
images name a digest (`node:24-slim@sha256:…`). A tag can be moved by
whoever controls it; a SHA or digest cannot. The jobs that build run with a
read-only token; only the small jobs that attest, push or upload (`attest`
and `publish` in release.yml, `publish` in runtime-image.yml, `move` in
promote-images.yml) can write, and they run no project code.
`test/workflowPins.test.ts` fails CI when a `uses:` is not a SHA, a checkout
keeps its git credentials, a job that installs or builds can write, or an
image pin is missing.

- **The reviewed path:** Dependabot (`.github/dependabot.yml`, in the dev
  repo only: the file is never published) opens a weekly pull request for
  actions and for the `FROM` lines in `docker/`. Read the upstream release
  notes, let CI pass, merge.
- **What Dependabot does not see:** `ARG NODE_IMAGE=` in
  `docker/Dockerfile.runtime` and `CHROME_IMAGE` in
  `scripts/ui-clickthrough.mjs` (with the matching `pull` in `ci.yml`). Bump those by hand, as below.
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
~/hatchabot-prod   # production: always at a tag; nothing edited by hand; pulls from the public repo (push DISABLED)
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
