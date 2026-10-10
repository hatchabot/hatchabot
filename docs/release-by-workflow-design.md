# Design: release by workflow, and main through pull requests

Status: **proposal, for review** (2026-10-10). From a security audit of
v2.158.2: #37 (CI and main ancestry before publication), #38 (immutable
releases and artifact provenance), #47 (runtime images bound to release
digests). The maintainer chose: a design first, and changes to `main` only
through pull requests that merge themselves on green CI.

## How a release is made today

1. On the maintainer's machine: the gates, `npm version`, a commit, a tag,
   `git push origin main vX.Y.Z`, then `gh release create` with the
   CHANGELOG section as notes.
2. The tag push starts `runtime-image.yml`: it builds the multi-arch runtime
   image and moves `:vX.Y.Z`, the ref name and `:latest`.
3. The published release starts `bundles.yml`: it builds the three bundles
   and uploads them onto the **already published** release with `--clobber`.
4. `promote.sh` moves `stable`/`beta` in `channels.json` (it checks main-push
   CI and the live tests first).
5. Installs and upgrades download a bundle and its `.sha256` from the same
   release, and pull the runtime image by tag, falling back to one whose
   version label matches.

What the audit found in that: a tag is not tied to a commit that passed CI on
`main`; a published release keeps changing for minutes (assets arrive after
it), and any later run can replace them; a checksum fetched from the same
place proves the download is whole, not where it came from; and any tag
build — even a re-run of an old one — moves `:latest`.

## Proposal

### 1. `main` through pull requests

- Work goes on a branch; `gh pr create --fill && gh pr merge --auto --rebase`.
  The PR merges itself when the required checks pass (`test`, `ui`,
  `secrets`, `upgrade`, `privacy` — about ten minutes). No human approval is required
  (one maintainer); history stays linear.
- A ruleset on `main`: pull request required (0 approvals), those checks
  required, linear history; force-push and deletion stay refused. The
  repository admin keeps a **bypass for emergencies** (documented below).
- The commits this session's tooling makes straight to `main` today go
  through PRs too: the live-test record and `promote.sh` (it opens the
  channel-only PR, waits for it to merge, and reports).

### 2. One release workflow

`release.yml`, started by hand (`gh workflow run release -f version=X.Y.Z`,
wrapped as `hbt release X.Y.Z`):

1. **Check** (read-only): the commit is `main`'s head (or a named commit on
   `main`); `package.json` says X.Y.Z; CHANGELOG has `## [X.Y.Z]`; main-push
   CI succeeded on that commit; the tag does not exist yet.
2. **Build** (read-only jobs, no publication credentials): the three bundles
   and the multi-arch runtime image, as artifacts — pushed nowhere yet.
3. **Manifest**: `release-manifest.json` — version, commit, each asset's name,
   size and sha256, the runtime image's index digest and per-architecture
   digests, and the build inputs (OpenClaw version, the pinned base image
   digests). A GitHub build-provenance attestation (Sigstore) over the
   bundles and the manifest, checkable with `gh attestation verify`.
4. **Publish** (one small job with write access, runs no project code): push
   the image by digest and tag `:vX.Y.Z` (refused if that tag already names
   another digest); create the tag on the checked commit; create a **draft**
   release with the notes; upload the assets and the manifest; check every
   expected asset is there; **publish**. With GitHub's **immutable releases**
   turned on, nothing about the release can change after that.

A failure leaves a draft and no tag movement; the workflow can be re-run.
A ruleset lets only this workflow create `v*` tags (the existing rules
already refuse moving or deleting them).

The household privacy check's values stay on this machine; GitHub checks
their keyed fingerprints (section 5). `hbt release` syncs them
(`privacy-check.mjs --sync-ci`) and runs `privacy-check.mjs --text` on the
notes before starting the workflow, and the `privacy` live test checks the
published release before any promote, as today.

### 3. What installs and upgrades trust

- They read `release-manifest.json` from the (immutable) release and check
  the bundle's sha256 against it; the separate `.sha256` files stay for
  older installers.
- They pull the runtime image **by digest** from the manifest; the
  "same version label" fallback goes (a label is not proof of content).
- Installs do not verify the Sigstore attestation themselves (they don't have
  `gh` or `cosign`); an immutable release created only by the workflow is
  what they rely on. The attestation is for anyone who wants to check, and
  the release workflow verifies its own before publishing.

### 4. Image aliases move only on promotion

- A release build tags only `:vX.Y.Z`. `:latest`, `:beta` and `:stable` move
  in a separate `promote-images` workflow that `promote.sh` starts: one at a
  time (`concurrency: image-aliases`), by the digest in that release's
  manifest, and never backwards (it compares the version labels).
- Re-running an old release's build is refused (its version exists), so a
  historical re-run can no longer change an image or move an alias.

### 5. Privacy, enforced on GitHub's side

The owner's main concern: AI agents writing private values (real agent
names, people, emails, machine and tailnet names) into this public repo. The
checks so far — the pre-push hook, the release-notes check, the `privacy`
live test — all need the private values, which live only on the owner's
machine, so text written anywhere else (another machine's agent, a web edit,
a pull request made elsewhere) was not checked. So:

- This machine computes a **keyed fingerprint** (HMAC) of every private value
  and stores only the fingerprints and the key in an encrypted GitHub Actions
  secret. GitHub never holds the values; a fingerprint can't be turned back
  into a name.
- A **`privacy` CI job** fingerprints every run of words in what a pull
  request or push adds — the diff, file names, commit messages, authors, the
  pull request's title and description — and fails on a match, printing only
  a masked hint and where. With `main` behind pull requests, this check is
  **required**: nothing reaches `main` without passing it, whoever or
  whatever wrote the change.
- A daily timer on this machine refreshes the fingerprints, so a new agent's
  name is covered within a day; a release refreshes them first.
- A daily **watch workflow** scans new issues, comments, pull request text
  and release notes, and fails — GitHub emails the owner — on a match.
- **Fail closed:** a missing or unreadable fingerprint set fails the check.
- What it cannot catch: a private value Hatchabot has no record of, a
  paraphrase, text inside images. The rule in `AGENTS.md` (examples from the
  invented household) stays the first line of defence.

## Emergencies

- **A broken `main` that blocks every PR:** the admin bypass lets the
  maintainer push a fix directly; noted in the commit.
- **A release that must go out while GitHub Actions is down:** wait. There is
  no local path to publish once the rules are on — that is the point. (A
  local tag push is refused by the tag rule.)
- **A bad release:** publish a new patch release; `promote.sh` with a lower
  version already rolls a channel back. Releases are never deleted or edited.

## Rollout

1. Build `release.yml`, `promote-images.yml`, the manifest step, the
   installer/upgrade checks (with tests that run the scripts against a fake
   release: a missing asset, a sha256 or digest mismatch, a missing manifest
   from an older release).
2. A dry run: the workflow with `draft_only` makes a complete draft release
   for a pre-release version, which is checked and then deleted.
3. The first real release through the workflow.
4. Then turn on: immutable releases, the `v*` tag-creation rule, the `main`
   pull-request rule and auto-merge; update `docs/releasing.md`, `AGENTS.md`
   and the release steps this machine uses.

Existing releases stay as they are: not re-uploaded, not deleted, not frozen
(#38: historical assets are a separate decision).

## Questions for review

(Answered so far: the privacy layer above — build it, 2026-10-10.)


1. **Merge method:** rebase (keeps each commit, as today) — proposed — or
   squash (one commit per PR)?
2. **Installs and the attestation:** rely on the immutable release (proposed),
   or also ship a small verifier so installs check the Sigstore attestation?
3. **Order:** pull requests on `main` first (small, independent), then the
   release workflow — proposed — or both together?
