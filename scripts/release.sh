#!/usr/bin/env bash
# Make a release: tag the version commit in the private dev repo (origin).
# The publisher does the rest (docs/releasing.md, "How a release reaches
# the public repo"): it gates the tag's tree and notes, waits an hour, gates
# them again, and pushes one release commit and the tag to the public repo,
# whose release workflow (.github/workflows/release.yml) builds, attests and
# publishes the release. Nothing is built or uploaded from this machine.
#
#   scripts/release.sh X.Y.Z [--commit <sha>]
#   hbt release X.Y.Z
#
# It refuses unless local main is origin/main, the version commit has landed
# (package.json and a CHANGELOG section for X.Y.Z on main), CI passed on it
# (it waits for a run still going), the tag is free, here and on the
# public repo (the remote `public`, read only), and the commit's
# channels.json moves no channel back from what either main says —
# scripts/release-check.sh.
# Then the release notes go through the privacy check (`privacy-check.mjs
# --text`) and the public repo's privacy fingerprints are brought up to date
# (`--sync-ci`), both here, where the private values are. Then it makes the
# annotated tag vX.Y.Z on the version commit and pushes that one tag, by
# name, to origin (never `git push --tags`); a refused push deletes the
# local tag again. `--commit <sha>` tags an earlier commit on main instead
# of its head.
#
# Exit: 0 tagged; 1 refused; 2 usage.
set -euo pipefail
cd "$(dirname "$0")/.."
die() { echo "✗ $1" >&2; exit "${2:-1}"; }

VERSION=""; COMMIT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --draft-only) die "--draft-only is gone: a release is built only on the public repo, once the publisher has published its tag (docs/releasing.md)" 2 ;;
    --commit) COMMIT="${2:-}"; shift 2 ;;
    -*) die "unknown option $1 (scripts/release.sh X.Y.Z [--commit <sha>])" 2 ;;
    *) [ -z "$VERSION" ] || die "one version only" 2; VERSION="${1#v}"; shift ;;
  esac
done
[ -n "$VERSION" ] || die "usage: scripts/release.sh X.Y.Z [--commit <sha>]" 2
# The publisher publishes vX.Y.Z tags only: a pre-release tagged here would
# never reach the public repo, while this said it would (audit, 2026-10-22).
case "$VERSION" in *-*) die "$VERSION is a pre-release: the publisher publishes X.Y.Z releases only, so its tag would never reach the public repo. Nothing tagged." 2 ;; esac
command -v gh >/dev/null 2>&1 || die "No gh command: install it and gh auth login."
# The dev repository, whose CI is checked: origin.
SLUG="$(git remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
echo "$SLUG" | grep -qE '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || SLUG="${HATCHABOT_DEV_SLUG:-cksci/hatchabot-dev}"
# The public repo, read only (its push URL is DISABLED): a tag name it has
# ever had is used for good.
PUBLIC="${HATCHABOT_PUBLIC_REMOTE:-public}"
git remote get-url "$PUBLIC" >/dev/null 2>&1 \
  || die "No remote '$PUBLIC' for the public repo — add it, read only: git remote add --no-tags public https://github.com/hatchabot/hatchabot.git && git remote set-url --push public DISABLED"

# What GitHub's main holds and nothing else: the release is made from there,
# so a local commit not landed yet would not be in it.
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "Run it on main (this is $(git rev-parse --abbrev-ref HEAD))."
git fetch -q origin main || die "Could not fetch main from origin."
AHEAD="$(git rev-list --count origin/main..HEAD)"; BEHIND="$(git rev-list --count HEAD..origin/main)"
[ "$AHEAD" = 0 ] && [ "$BEHIND" = 0 ] \
  || die "Local main is not origin/main ($AHEAD commits ahead, $BEHIND behind) — land the version commit (scripts/land.sh) or pull first."

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
OUT="$(bash scripts/release-check.sh "$VERSION" ${COMMIT:+--commit "$COMMIT"} --repo "$SLUG" --public "$PUBLIC" --notes "$WORK/notes.md" --wait-ci)" || die "The release check stopped (exit $?) — its reason is above; with none, run scripts/release-check.sh $VERSION by hand."
val() { printf '%s\n' "$OUT" | sed -n "s/^$1=//p"; }
SHA="$(val commit)"; TAG="$(val tag)"

# The notes are published apart from the code: no push hook sees them.
node scripts/privacy-check.mjs --text "$WORK/notes.md" \
  || die "The release notes did not pass the privacy check (above) — fix the CHANGELOG section, land it, run this again."
node scripts/privacy-check.mjs --sync-ci \
  || die "Could not bring the public repo's privacy fingerprints up to date (above) — its release workflow would check the notes with an old set."

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "$TAG already exists in this clone (not on origin) — delete it (git tag -d $TAG) and run again."
git tag -a "$TAG" "$SHA" -m "hatchabot $TAG"
# One tag, by name; the pre-push hooks check it (the tag guard and the
# privacy check on its message and tagger).
if ! git push -q origin "refs/tags/$TAG"; then
  git tag -d "$TAG" >/dev/null
  die "The push of $TAG was refused (above) — nothing published; the local tag is deleted again."
fi
WAIT_H="$({ sed -nE 's/^wait_hours[[:space:]]*=[[:space:]]*([0-9.]+).*/\1/p' publish.toml 2>/dev/null || true; } | sed -n 1p)"
echo "✓ tagged $TAG on ${SHA:0:9} in $SLUG."
echo "  The publisher gates it, waits ${WAIT_H:-1} hour(s) (its digest issue in cksci/publisher says when), gates it again and"
echo "  publishes it to the public repo, whose release workflow then builds and publishes the release: then it is 'latest'."
echo "  Scheduled publisher runs come hours apart; to go sooner, start one after tagging and after the wait:"
echo "  gh workflow run publish.yml -R cksci/publisher   (or Actions → publish → Run workflow, in the browser)"
