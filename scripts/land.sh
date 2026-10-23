#!/usr/bin/env bash
# Land this clone's new commits on main through a pull request, in the
# private dev repo (origin; docs/releasing.md): every change passes CI —
# test, ui, secrets, upgrade — whoever or whatever made it. This pushes the
# commits as a branch, opens the pull request, and has it rebase-merged once
# its checks pass: by GitHub's auto-merge when main's rules require checks
# and the repository allows it; otherwise (the dev repo has no such rule)
# it waits for every check itself and merges. Then it brings local main to
# what landed. Work not yet committed is left as it was.
#
# A failed check (or a pull request closed meanwhile) turns auto-merge off,
# closes the pull request and deletes its branch: nothing merges later
# behind your back; the commits stay on local main to fix and land again.
#
#   scripts/land.sh [--no-wait] [--timeout <minutes>] [--footer <text>]
#
# Exit: 0 landed (or nothing to land); 1 a check failed, the pull request
# was closed, or a push / merge failed; 2 refused before anything was
# pushed; 3 still waiting at the timeout (the pull request stays open; with
# auto-merge it merges by itself, else the message says how to merge it).
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
# GitHub refuses to rebase-merge a pull request this long ("This branch can't
# be rebased"), and turns its auto-merge off: 106 commits failed, 53 landed
# (2026-10-10). Land the first part, then the rest.
[ "$AHEAD" -le 100 ] || die "$AHEAD commits are more than GitHub rebase-merges at once (100): land the first part (git reset to an earlier commit, land, then cherry-pick the rest)."

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
URL="$(printf '%s\n' "$URL" | grep -oE 'https://[^ ]+/pull/[0-9]+' | tail -1)"
[ -n "$URL" ] || die "gh pr create gave no pull request address (the branch $BRANCH is pushed)." 1

# GitHub's auto-merge only when main's rules require checks (otherwise a
# pull request with nothing required is mergeable at once, before CI) and
# the repository allows it; else this script waits for the checks itself.
AUTO=0
# Rules that cannot be read count as none: then this script waits for every
# check itself, the stricter of the two paths.
REQUIRED="$(gh api "repos/$SLUG/rules/branches/main" --jq '[.[] | select(.type == "required_status_checks")] | length' 2>/dev/null || echo 0)"
if [ "${REQUIRED:-0}" != 0 ] && gh pr merge "$URL" --repo "$SLUG" --auto --rebase --delete-branch >/dev/null 2>&1; then
  AUTO=1
  echo "→ $URL: GitHub merges it (rebase) once its required checks pass"
else
  echo "→ $URL: merging it (rebase) here once every check has passed"
fi
[ "$WAIT" = 1 ] || exit 0

fail() {   # fail MESSAGE — nothing may merge later behind the caller's back
  [ "$AUTO" = 0 ] || gh pr merge "$URL" --repo "$SLUG" --disable-auto >/dev/null 2>&1 || true
  gh pr close "$URL" --repo "$SLUG" --delete-branch >/dev/null 2>&1 || true
  die "$1 — the pull request is closed and its branch deleted; the commits stay on local main: fix, commit, and land again." 1
}
# Every check of the pushed commit, one "name<TAB>pass|fail|cancel|skipping|pending" line each:
# the jobs of its Actions runs on this branch, and its commit statuses. Not `gh pr checks`: the
# check-runs API it reads needs a permission fine-grained personal tokens cannot have, and the
# everyday token is one (publish kit D8, 2026-10-17). A run not finished yet, or one whose jobs
# cannot be read, counts as pending; one that ended with no job is a failure (a broken workflow).
SHA="$(git rev-parse HEAD)"
# A read that fails, and CI with no run yet, is a pending line, never nothing: with nothing from
# one source, the other's green alone passed the gate, and this script is the dev repo's only
# gate (review of an external audit, A01, 2026-10-22).
checks() {
  local id status name jobs runs statuses
  runs="$(gh api "repos/$SLUG/actions/runs?branch=$BRANCH&head_sha=$SHA&per_page=100" \
      --jq '.workflow_runs[] | [(.id | tostring), .status, .name] | @tsv' 2>/dev/null)" \
    || { printf 'Actions runs (unreadable)\tpending\n'; runs=""; }
  [ -n "$runs" ] || printf 'Actions runs (none yet)\tpending\n'
  printf '%s\n' "$runs" |
  while IFS="$(printf '\t')" read -r id status name; do
    [ -n "$id" ] || continue
    [ "$status" = completed ] || { printf '%s\tpending\n' "$name"; continue; }
    jobs="$(gh api "repos/$SLUG/actions/runs/$id/jobs?per_page=100" --jq '.jobs[] | [.name,
        (if .status != "completed" then "pending" elif .conclusion == "success" or .conclusion == "neutral" then "pass"
         elif .conclusion == "skipped" then "skipping" elif .conclusion == "cancelled" then "cancel" else "fail" end)] | @tsv' 2>/dev/null)" \
      || { printf '%s\tpending\n' "$name"; continue; }
    [ -n "$jobs" ] && printf '%s\n' "$jobs" || printf '%s\tfail\n' "$name"
  done
  statuses="$(gh api "repos/$SLUG/commits/$SHA/status" --jq '.statuses[] | [.context,
      (if .state == "success" then "pass" elif .state == "pending" then "pending" else "fail" end)] | @tsv' 2>/dev/null)" \
    || { printf 'commit statuses (unreadable)\tpending\n'; return 0; }
  [ -z "$statuses" ] || printf '%s\n' "$statuses"
}
END=$(( $(date +%s) + TIMEOUT * 60 ))
while :; do
  VIEW="$(gh pr view "$URL" --repo "$SLUG" --json state,autoMergeRequest -q '.state + " " + (if .autoMergeRequest then "auto" else "noauto" end)' 2>/dev/null || echo UNKNOWN)"
  STATE="${VIEW%% *}"
  case "$STATE" in
    MERGED) break ;;
    CLOSED) die "The pull request was closed without merging: $URL" 1 ;;
  esac
  CHECKS="$(checks)"
  FAILED="$(printf '%s\n' "$CHECKS" | awk -F'\t' '$2 == "fail" || $2 == "cancel" { printf "%s, ", $1 }')"
  [ -z "$FAILED" ] || fail "Check(s) failed: ${FAILED%, } ($URL)"
  # Counted whole (wc reads everything): `grep -q` would stop early and,
  # with pipefail, turn a writer's SIGPIPE into "every check passed".
  NOTPASS="$(printf '%s\n' "$CHECKS" | awk -F'\t' 'NF >= 2 && $2 != "pass" && $2 != "skipping"' | wc -l)"
  if [ -n "$CHECKS" ] && [ "$NOTPASS" -eq 0 ]; then
    if [ "$AUTO" = 0 ]; then
      gh pr merge "$URL" --repo "$SLUG" --rebase --delete-branch >/dev/null \
        || die "Every check passed but the merge failed: $URL (merge it on GitHub, then git pull --rebase)." 1
    elif [ "$VIEW" = "OPEN noauto" ]; then
      # Every check passed and GitHub dropped the auto-merge (it does when it
      # cannot merge, e.g. a rebase it refuses): nothing will merge it.
      die "Its checks passed but GitHub turned auto-merge off, so it will not merge by itself: see $URL (gh pr merge --rebase says why)." 1
    fi
  fi
  if [ "$(date +%s)" -ge "$END" ]; then
    [ "$AUTO" = 0 ] || die "Still waiting after $TIMEOUT min: $URL merges by itself when its checks pass." 3
    die "Still waiting after $TIMEOUT min: once $URL's checks pass, merge it (gh pr merge $URL --rebase --delete-branch), then git pull --rebase." 3
  fi
  sleep "${HATCHABOT_LAND_POLL_SECS:-20}"
done
# What landed is the rebased copy of these commits: rebasing onto it drops ours.
git pull -q --rebase --autostash origin main
echo "✓ landed $AHEAD commit(s): $URL"
