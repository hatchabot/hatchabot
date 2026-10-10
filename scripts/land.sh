#!/usr/bin/env bash
# Land this clone's new commits on main through a pull request. main's
# ruleset takes no direct push (docs/release-by-workflow-design.md): every
# change passes the required checks — test, ui, secrets, upgrade, privacy —
# whoever or whatever made it. This pushes the commits as a branch, opens the
# pull request, asks GitHub to merge it (rebase) once its checks pass, waits,
# and brings local main to what landed. Work not yet committed is left as
# it was.
#
#   scripts/land.sh [--no-wait] [--timeout <minutes>] [--footer <text>]
#
# Exit: 0 landed (or nothing to land); 1 a check failed or the pull request
# was closed; 2 refused before anything was pushed; 3 still waiting at the
# timeout (the pull request stays open and merges by itself when it can).
# HATCHABOT_LAND_DIRECT=1 pushes straight to main instead — only for a
# remote with no such rule (the script tests' throwaway remote).
set -euo pipefail
cd "$(dirname "$0")/.."
die() { echo "✗ $1" >&2; exit "${2:-2}"; }
WAIT=1; TIMEOUT=45; FOOTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-wait) WAIT=0; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --footer) FOOTER="$2"; shift 2 ;;
    *) die "unknown option $1 (scripts/land.sh [--no-wait] [--timeout <minutes>] [--footer <text>])" ;;
  esac
done

[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "Run it on main (this is $(git rev-parse --abbrev-ref HEAD))."
git fetch -q origin main
AHEAD="$(git rev-list --count origin/main..HEAD)"
BEHIND="$(git rev-list --count HEAD..origin/main)"
[ "$AHEAD" -gt 0 ] || { echo "Nothing to land: main is origin/main."; exit 0; }
[ "$BEHIND" = 0 ] || die "main moved on by $BEHIND commit(s) — git pull --rebase first, then land."

if [ "${HATCHABOT_LAND_DIRECT:-}" = 1 ]; then
  git push -q origin main || die "The push was refused." 1
  echo "✓ landed $AHEAD commit(s) on main (direct)"
  exit 0
fi

command -v gh >/dev/null || die "No gh command: install it and gh auth login."
SLUG="$(git remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
FIRST="$(git log -1 --format=%s "$(git rev-list --reverse origin/main..HEAD | sed -n 1p)")"
TITLE="$(git log -1 --format=%s)"
[ "$AHEAD" = 1 ] || TITLE="$FIRST (+$((AHEAD - 1)) more)"
BODY="$(git log --reverse --format='- %s' origin/main..HEAD)"
[ -z "$FOOTER" ] || BODY="$BODY

$FOOTER"
BRANCH="land/$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"

git push -q origin "HEAD:refs/heads/$BRANCH" || die "Could not push the branch $BRANCH." 1
URL="$(gh pr create --repo "$SLUG" --base main --head "$BRANCH" --title "$TITLE" --body "$BODY")" \
  || die "Could not open the pull request (the branch $BRANCH is pushed)." 1
gh pr merge "$URL" --repo "$SLUG" --auto --rebase --delete-branch >/dev/null \
  || die "Could not turn on auto-merge for $URL." 1
echo "→ $URL: merges by itself once its checks pass"
[ "$WAIT" = 1 ] || exit 0

END=$(( $(date +%s) + TIMEOUT * 60 ))
while :; do
  STATE="$(gh pr view "$URL" --repo "$SLUG" --json state -q .state 2>/dev/null || echo UNKNOWN)"
  case "$STATE" in
    MERGED) break ;;
    CLOSED) die "The pull request was closed without merging: $URL" 1 ;;
  esac
  FAILED="$(gh pr checks "$URL" --repo "$SLUG" --json name,bucket -q '.[] | select(.bucket=="fail") | .name' 2>/dev/null | tr '\n' ' ')"
  [ -z "$FAILED" ] || die "Check(s) failed: ${FAILED% } — see $URL. Fix, commit, and land again (the pull request stays open)." 1
  [ "$(date +%s)" -lt "$END" ] || die "Still waiting after $TIMEOUT min: $URL merges by itself when its checks pass." 3
  sleep 20
done
# What landed is the rebased copy of these commits: rebasing onto it drops ours.
git pull -q --rebase --autostash origin main
echo "✓ landed $AHEAD commit(s): $URL"
