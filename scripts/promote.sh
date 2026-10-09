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
# ago. It commits channels.json on main and pushes — no new tag, no rebuild.
set -euo pipefail
cd "$(dirname "$0")/.."
die() { echo "✗ $*" >&2; exit 1; }

TAG="${1:-}"; CH="${2:-stable}"
[ -n "$TAG" ] || die "Usage: ./scripts/promote.sh <tag> [stable|beta]"
case "$CH" in stable|beta) ;; *) die "Channel must be stable or beta (latest is always the newest tag)." ;; esac
git fetch --tags --force --quiet origin
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "No tag $TAG — tag and push the release first."
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
if [ "$CURRENT" = "$TAG" ]; then echo "$CH already points at $TAG."; exit 0; fi
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
  local slug="${HATCHABOT_SLUG:-hatchabot/hatchabot}" sha runs id st
  sha="$(git rev-list -n 1 "$TAG")"
  # The run for the push to main: a pull request's run on the same commit
  # tests it merged into whatever its base was then, not as main (review, 2026-10-09).
  runs="$(gh run list --repo "$slug" --workflow ci.yml --commit "$sha" --event push --branch main --limit 1 --json databaseId,status,conclusion -q '.[] | "\(.databaseId) \(.status) \(.conclusion)"')" \
    || die "Could not ask GitHub about CI for $TAG ($how)."
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

sed -i.bak -E "s/(\"$CH\"[[:space:]]*:[[:space:]]*\")v[^\"]*(\")/\1$TAG\2/" channels.json && rm -f channels.json.bak
grep -q "\"$CH\": \"$TAG\"" channels.json || die "Could not update channels.json."
git add channels.json
# Trailers only when the caller passes them (HATCHABOT_PROMOTE_TRAILERS, one
# per line): a fixed Co-Authored-By and session URL stamped every promote
# with a session that never made it (review, 2026-09-29).
MSG="Promote $TAG to $CH"
[ -z "${HATCHABOT_PROMOTE_TRAILERS:-}" ] || MSG="$MSG

$HATCHABOT_PROMOTE_TRAILERS"
git commit -q -m "$MSG"
# A refused push (main moved on meanwhile) used to leave the promote commit
# here, and a re-run then said "already points at" with GitHub unchanged
# (review, 2026-10-09). Take it back off, as if it had not been made.
if ! git push -q origin main; then
  git reset -q --soft HEAD~1 && git reset -q -- channels.json && git checkout -q -- channels.json
  die "The push to origin was refused (did main move on?) — nothing changed here or there. Pull, then run it again."
fi
echo "✓ $CH → $TAG  (was ${CURRENT:-unset}). New installs on $CH get it now."
