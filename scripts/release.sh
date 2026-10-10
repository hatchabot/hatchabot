#!/usr/bin/env bash
# Make a release: GitHub's release workflow builds, attests and publishes it
# (.github/workflows/release.yml; docs/releasing.md, "Cutting a release";
# issues #37, #38, #47, 2026-10-10). Nothing is tagged, built or uploaded
# from this machine; this checks first, then starts the workflow and
# follows it.
#
#   scripts/release.sh X.Y.Z [--draft-only] [--commit <sha>]
#   hbt release X.Y.Z [--draft-only]
#
# It refuses unless local main is origin/main, the version commit has landed
# (package.json and a CHANGELOG section for X.Y.Z on main), CI passed on it
# (it waits for a run still going) and the tag is free — scripts/release-check.sh,
# which the workflow runs again. Then the release notes go through the
# privacy check (`privacy-check.mjs --text`) and GitHub's privacy
# fingerprints are brought up to date (`--sync-ci`), both here, where the
# private values are. --draft-only makes the whole release as a draft and
# stops there: no tag, no image tag, nothing published (the dry run).
#
# Exit: 0 released (or drafted); 1 refused or the workflow failed; 2 usage.
set -euo pipefail
cd "$(dirname "$0")/.."
die() { echo "✗ $1" >&2; exit "${2:-1}"; }

VERSION=""; DRAFT=false; COMMIT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --draft-only) DRAFT=true; shift ;;
    --commit) COMMIT="${2:-}"; shift 2 ;;
    -*) die "unknown option $1 (scripts/release.sh X.Y.Z [--draft-only] [--commit <sha>])" 2 ;;
    *) [ -z "$VERSION" ] || die "one version only" 2; VERSION="${1#v}"; shift ;;
  esac
done
[ -n "$VERSION" ] || die "usage: scripts/release.sh X.Y.Z [--draft-only] [--commit <sha>]" 2
command -v gh >/dev/null 2>&1 || die "No gh command: install it and gh auth login."
SLUG="$(git remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
echo "$SLUG" | grep -qE '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || SLUG="${HATCHABOT_SLUG:-hatchabot/hatchabot}"

# What GitHub's main holds and nothing else: the release is made from there,
# so a local commit not landed yet would not be in it.
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "Run it on main (this is $(git rev-parse --abbrev-ref HEAD))."
git fetch -q origin main || die "Could not fetch main from origin."
AHEAD="$(git rev-list --count origin/main..HEAD)"; BEHIND="$(git rev-list --count HEAD..origin/main)"
[ "$AHEAD" = 0 ] && [ "$BEHIND" = 0 ] \
  || die "Local main is not origin/main ($AHEAD commits ahead, $BEHIND behind) — land the version commit (scripts/land.sh) or pull first."

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
OUT="$(bash scripts/release-check.sh "$VERSION" ${COMMIT:+--commit "$COMMIT"} --repo "$SLUG" --notes "$WORK/notes.md" --wait-ci)" || die "The release check stopped (exit $?) — its reason is above; with none, run scripts/release-check.sh $VERSION by hand."
val() { printf '%s\n' "$OUT" | sed -n "s/^$1=//p"; }
SHA="$(val commit)"; TAG="$(val tag)"

# The notes are published apart from the code: no push hook sees them.
node scripts/privacy-check.mjs --text "$WORK/notes.md" \
  || die "The release notes did not pass the privacy check (above) — fix the CHANGELOG section, land it, run this again."
node scripts/privacy-check.mjs --sync-ci \
  || die "Could not bring GitHub's privacy fingerprints up to date (above) — the release's checks would use an old set."

RUN="$(bash scripts/dispatch-run.sh "$SLUG" release.yml -f version="$VERSION" -f commit="$SHA" -f draft_only="$DRAFT")" \
  || die "The release workflow did not start (above)."
echo "→ $TAG from ${SHA:0:9}$([ "$DRAFT" = true ] && echo ' (draft only)'): https://github.com/$SLUG/actions/runs/$RUN"
echo "  following it (builds take a while; Ctrl-C stops following, not the release)…"
gh run watch "$RUN" --repo "$SLUG" --exit-status >/dev/null \
  || die "The release workflow failed: https://github.com/$SLUG/actions/runs/$RUN — nothing is published before its last step. Once the cause is fixed: gh run rerun $RUN --failed --repo $SLUG"
URL="$(gh release view "$TAG" --repo "$SLUG" --json url -q .url 2>/dev/null || true)"
if [ "$DRAFT" = true ]; then
  echo "✓ draft $TAG made, nothing published: ${URL:-https://github.com/$SLUG/releases}"
  echo "  Check it, then delete it: gh release delete $TAG --repo $SLUG --yes   (no tag was made)"
else
  echo "✓ released $TAG: ${URL:-https://github.com/$SLUG/releases/tag/$TAG}"
fi
