#!/usr/bin/env bash
# Point a release channel at a tag — what new installs (and re-runs of the
# installer on that channel) get from now on.
#
#   ./scripts/promote.sh v2.31.0            # stable
#   ./scripts/promote.sh v2.32.0-beta.1 beta
#   HATCHABOT_PROMOTE_TRAILERS='Co-Authored-By: …' ./scripts/promote.sh v2.31.0
#
# Tagging a release makes it `latest` and nothing more; `stable` only moves
# when you run this. That is what lets you release several times a day
# without a stranger's first install landing on whatever you tagged an hour
# ago. It lands channels.json on the dev repo's main (origin, through
# scripts/land.sh) and asks the publisher for the fast lane with a tag
# channels-YYYYMMDDTHHMMSSZ (UTC) on that commit: the publisher copies that
# one file to the public repo on its next run (gated, no wait), and the
# public repo's promote-images.yml then moves the runtime image's
# :stable/:beta to that release's image. No release tag, no rebuild.
#
# Only a published release can be promoted: the public repo (the remote
# `public`, read only) has its tag. The fast lane refuses a channels.json
# naming any other.
set -euo pipefail
cd "$(dirname "$0")/.."
die() { echo "✗ $*" >&2; exit 1; }

TAG="${1:-}"; CH="${2:-stable}"
[ -n "$TAG" ] || die "Usage: ./scripts/promote.sh <tag> [stable|beta]"
case "$CH" in stable|beta) ;; *) die "Channel must be stable or beta (latest is always the newest tag)." ;; esac
git fetch --tags --force --quiet origin
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "No tag $TAG — tag and push the release first."
PUBLIC="${HATCHABOT_PUBLIC_REMOTE:-public}"
git remote get-url "$PUBLIC" >/dev/null 2>&1 \
  || die "No remote '$PUBLIC' for the public repo — add it, read only: git remote add --no-tags public https://github.com/hatchabot/hatchabot.git && git remote set-url --push public DISABLED"
PUB_TAG="$(git ls-remote --tags "$PUBLIC" "refs/tags/$TAG")" || die "Could not list the public repo's tags."
[ -n "$PUB_TAG" ] || die "$TAG is not published yet (the public repo has no such tag): the publisher publishes it after its wait — promote it then."
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "Promote from main."
[ -z "$(git status --porcelain channels.json)" ] || die "channels.json has uncommitted changes."
# What GitHub's main holds, and nothing else. The promote commit is pushed as
# `main`, so a local commit not yet pushed (work in progress) rode along with
# it; and the channel's current release is read from there, not from a local
# file that may be behind (review, 2026-10-09).
AHEAD="$(git rev-list --count origin/main..HEAD)"; BEHIND="$(git rev-list --count HEAD..origin/main)"
[ "$AHEAD" = 0 ] && [ "$BEHIND" = 0 ] \
  || die "Local main is not origin/main ($AHEAD commits ahead, $BEHIND behind) — push or pull first, so a promote publishes nothing but itself."
# A release that is not on main (a tag on a side branch) never passed main's CI.
git merge-base --is-ancestor "$TAG^{commit}" origin/main || die "$TAG is not on main — promote only releases tagged on main."

CURRENT="$(git show origin/main:channels.json | sed -nE "s/.*\"$CH\"[[:space:]]*:[[:space:]]*\"(v[^\"]+)\".*/\1/p" | sed -n 1p)"

# The fast lane: a channels-<UTC time> tag on origin's main, whose
# channels.json names $TAG, asks the publisher to copy that one file to the
# public repo. Nothing to do when the public main already has that file, or
# a fast-lane tag already names that commit.
fast_lane() {
  git fetch -q origin main || die "Could not fetch main from origin."
  local c pub name
  c="$(git rev-parse origin/main)"
  git show "$c:channels.json" | grep -q "\"$CH\": \"$TAG\"" \
    || die "origin/main's channels.json does not say $CH → $TAG."
  git fetch -q --no-tags "$PUBLIC" main || die "Could not fetch main from the public repo."
  pub="$(git show FETCH_HEAD:channels.json 2>/dev/null || true)"
  if [ "$pub" = "$(git show "$c:channels.json")" ]; then
    echo "✓ $CH points at $TAG on the public repo."; return 0
  fi
  if git ls-remote origin 'refs/tags/channels-*' | grep -q "^$c[[:space:]].*\^{}\$"; then
    echo "✓ $CH → $TAG is waiting for the publisher (a fast-lane tag names $(git rev-parse --short "$c"))."; return 0
  fi
  name="channels-$(date -u +%Y%m%dT%H%M%SZ)"
  git tag -a "$name" "$c" -m "hatchabot channels: $CH → $TAG"
  # One tag, by name — never `git push --tags`; the pre-push hooks check it.
  if ! git push -q origin "refs/tags/$name"; then
    git tag -d "$name" >/dev/null
    die "The push of the fast-lane tag $name was refused (above) — run scripts/promote.sh $TAG $CH again."
  fi
  echo "✓ $CH → $TAG asked of the publisher ($name): it copies channels.json to the public repo on its next run,"
  echo "  then the public repo's promote-images.yml moves the image :$CH. New installs and followers on $CH move then."
  echo "  Scheduled publisher runs come hours apart; to go sooner: gh workflow run publish.yml -R cksci/publisher"
}
if [ "$CURRENT" = "$TAG" ]; then echo "$CH already points at $TAG on main."; fast_lane; exit 0; fi
# Going backwards is allowed (a bad release gets rolled back this way) but it
# should never happen by accident.
# "~" sorts below everything in sort -V, so a prerelease ranks below its final release.
NEWER="$(printf '%s\n%s\n' "$CURRENT" "$TAG" | sed 's/-/~/' | sort -V | tail -1 | sed 's/~/-/')"
if [ -n "$CURRENT" ] && [ "$NEWER" = "$CURRENT" ]; then
  read -r -p "$CH is at $CURRENT; move it BACK to $TAG? [y/N] " ok
  [ "$ok" = "y" ] || die "Nothing changed."
fi

# CI must have passed on the commit the tag names. It failed for eight days
# unseen (2026-09-28 → 10-06: tests that passed here broke on GitHub's
# runner), and promote is where a release reaches strangers. Still running:
# wait for it. A rollback is not held to it — an older tag may predate a fix.
ci_gate() {
  if [ "${HATCHABOT_PROMOTE_IGNORE_CI:-}" = 1 ]; then echo "⚠ CI not checked (HATCHABOT_PROMOTE_IGNORE_CI=1)."; return 0; fi
  local how="HATCHABOT_PROMOTE_IGNORE_CI=1 promotes without the check"
  command -v gh >/dev/null 2>&1 || die "Can't check CI: the gh command is not installed ($how)."
  local slug sha runs id st
  slug="$(git remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
  echo "$slug" | grep -qE '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || slug="${HATCHABOT_DEV_SLUG:-cksci/hatchabot-dev}"
  sha="$(git rev-list -n 1 "$TAG")"
  # The dev repo's run for the push to main (origin): a pull request's run on
  # the same commit tests it merged into whatever its base was then, not as
  # main (review, 2026-10-09).
  ci_runs() { gh run list --repo "$1" --workflow ci.yml --commit "$sha" --event push --branch main --limit 1 --json databaseId,status,conclusion -q '.[] | "\(.databaseId) \(.status) \(.conclusion)"'; }
  runs="$(ci_runs "$slug")" || die "Could not ask GitHub about CI for $TAG ($how)."
  # A release from before the dev repo (v2.163.0 and older) was tested on
  # the public repo's main.
  if [ -z "$runs" ]; then
    slug="${HATCHABOT_SLUG:-hatchabot/hatchabot}"
    runs="$(ci_runs "$slug")" || die "Could not ask GitHub about CI for $TAG ($how)."
  fi
  [ -n "$runs" ] || die "No CI run for $TAG (${sha:0:9}) — was it pushed to main? ($how)"
  id="${runs%% *}"; st="${runs#* }"
  if [ "${st%% *}" != completed ]; then
    echo "CI for $TAG is still running — waiting for it…"
    gh run watch "$id" --repo "$slug" --exit-status >/dev/null 2>&1 || die "CI failed on $TAG: https://github.com/$slug/actions/runs/$id — nothing changed."
  elif [ "$st" != "completed success" ]; then
    die "CI failed on $TAG (${st#completed }): https://github.com/$slug/actions/runs/$id — nothing changed."
  fi
  echo "✓ CI passed on $TAG"
}
# The live tests (docs/live-tests.md): the unit suite and CI fake Docker,
# OpenClaw and the machines; these do not. Each is due when it has never
# passed, or a file in its area changed since the release it last passed on
# (docs/live-test-runs.md). Not for a rollback, as with CI.
live_gate() {
  if [ "${HATCHABOT_PROMOTE_IGNORE_LIVE:-}" = 1 ]; then echo "⚠ Live tests not checked (HATCHABOT_PROMOTE_IGNORE_LIVE=1)."; return 0; fi
  [ -f scripts/live.mjs ] || return 0
  command -v node >/dev/null 2>&1 || die "Can't check the live tests: node is not on PATH (HATCHABOT_PROMOTE_IGNORE_LIVE=1 promotes without the check)."
  node scripts/live.mjs gate "$TAG" \
    || die "Live tests are due for $TAG — run them (node scripts/live.mjs run <name>), commit docs/live-test-runs.md, then promote. HATCHABOT_PROMOTE_IGNORE_LIVE=1 promotes without them. Nothing changed."
  echo "✓ No live test is due for $TAG"
}
if [ -z "$CURRENT" ] || [ "$NEWER" != "$CURRENT" ]; then ci_gate; live_gate; fi

# The promote commit holds channels.json and nothing else. It used to `git
# add channels.json` and commit the whole index, so whatever the caller had
# staged went to main with it (audit issue #43, 2026-10-09). Now it commits
# with --only (git's own temporary index: HEAD plus channels.json), checks the
# commit changes exactly channels.json before pushing, and on any failure puts
# HEAD, the caller's index and channels.json back exactly as they were. Other
# staged or unstaged work is never touched.
START="$(git rev-parse HEAD)"
INDEX="$(git rev-parse --git-path index)"
SAVED="$(mktemp -d)"; trap 'rm -rf "$SAVED"' EXIT
cp -p channels.json "$SAVED/channels.json"
[ ! -f "$INDEX" ] || cp -p "$INDEX" "$SAVED/index"
undo() {
  git update-ref -m "promote: taken back" refs/heads/main "$START"
  if [ -f "$SAVED/index" ]; then cp -p "$SAVED/index" "$INDEX"; else rm -f "$INDEX"; fi
  cp -p "$SAVED/channels.json" channels.json
}
sed -i.bak -E "s/(\"$CH\"[[:space:]]*:[[:space:]]*\")v[^\"]*(\")/\1$TAG\2/" channels.json && rm -f channels.json.bak
grep -q "\"$CH\": \"$TAG\"" channels.json || { undo; die "Could not update channels.json."; }
# Trailers only when the caller passes them (HATCHABOT_PROMOTE_TRAILERS, one
# per line): a fixed Co-Authored-By and session URL stamped every promote
# with a session that never made it (review, 2026-09-29).
MSG="Promote $TAG to $CH"
[ -z "${HATCHABOT_PROMOTE_TRAILERS:-}" ] || MSG="$MSG

$HATCHABOT_PROMOTE_TRAILERS"
git commit -q --only -m "$MSG" -- channels.json || { undo; die "Could not commit channels.json — nothing changed."; }
CHANGED="$(git diff --name-only "$START" HEAD)"
[ "$CHANGED" = channels.json ] \
  || { undo; die "The promote commit would change more than channels.json ($(echo "$CHANGED" | tr '\n' ' ')) — nothing pushed, nothing changed."; }
# A refused push (main moved on meanwhile) used to leave the promote commit
# here, and a re-run then said "already points at" with GitHub unchanged
# (review, 2026-10-09). Take it back off, as if it had not been made.
# main takes changes only through a pull request with passing checks
# (scripts/land.sh); it opens one for this commit and waits for it to merge.
if ! "$(dirname "$0")/land.sh" --footer "Promotion by scripts/promote.sh: changes channels.json only."; then
  undo
  die "The promote did not land — nothing changed here. See the message above; run it again once it is fixed."
fi
echo "✓ $CH → $TAG on the dev repo's main (was ${CURRENT:-unset})."
fast_lane
