#!/usr/bin/env bash
# Land this clone's new commits on main through a pull request, in the
# private dev repo (origin; docs/releasing.md): every change passes CI —
# test, ui, secrets, upgrade, and the publish kit's kit-checks (known
# vulnerable pins, unsafe code patterns) — whoever or whatever made it. This
# pushes the commits as a branch, opens the pull request, and has it
# rebase-merged once
# its checks pass: by GitHub's auto-merge when main's rules require checks
# and the repository allows it; otherwise (the dev repo has no such rule)
# it waits for every check itself and merges. Then it brings local main to
# what landed. Work not yet committed is left as it was. Before it pushes,
# it runs CI's gitleaks scans when gitleaks is installed, and a hit refuses.
#
# --no-wait opens the pull request and stops there. That is enough only with
# GitHub's auto-merge on: otherwise the merge is this script's own, so it exits 3
# with the command to merge by hand, and local main stays as it is either way.
#
# A failed check (or a pull request closed meanwhile) turns auto-merge off,
# closes the pull request and deletes its branch: nothing merges later
# behind your back; the commits stay on local main to fix and land again.
# When GitHub does not confirm it closed, that is said, with its address.
#
#   scripts/land.sh [--no-wait] [--timeout <minutes>] [--footer <text>]
#
# Exit: 0 landed (or nothing to land), or with --no-wait auto-merge is on and
# GitHub merges it; 1 a check failed and the pull request
# is closed, the pull request was closed, or a push / merge failed; 2 refused
# before anything was pushed; 3 the pull request is still open: still waiting
# at the timeout (with auto-merge it merges by itself, else the message says
# how to merge it), --no-wait with nothing that will merge it, or a check failed
# and it could not be closed.
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

# CI's secrets job scans with gitleaks; its two scans run here first, before
# anything is pushed (HB-0852): a hit there cost a CI round, and the commits
# above the one it was in had to be made again. As the job runs them: the new
# commits, with the config from origin/main (a change cannot loosen what it is
# judged by; with none there, this change's); then the tree as plain files in
# a folder with no config or ignore list, gitleaks' default rules, as the
# publisher's gate sees a release. Without gitleaks it is said and skipped.
if command -v gitleaks >/dev/null; then
  SCAN="$(mktemp -d)"; trap 'rm -rf "$SCAN"' EXIT
  # The version CI's job pins (the V= of its step), read from the workflow so
  # the two cannot drift. Another one is said, not refused: the default rules
  # the tree scan uses change between versions, so this scan may not be CI's.
  GL_PIN="$({ git show HEAD:.github/workflows/ci.yml 2>/dev/null || true; } | awk '/name: gitleaks on the new commits/ { on = 1 } on && match($0, /V=[0-9][0-9.]*/) { print substr($0, RSTART + 2, RLENGTH - 2); exit }')"
  GL_HAVE="$({ gitleaks version 2>/dev/null || true; } | awk 'NR == 1 { gsub(/[[:space:]]/, ""); print }')"; GL_HAVE="${GL_HAVE#v}"
  if [ -z "$GL_PIN" ]; then
    echo "• CI's gitleaks version was not found in .github/workflows/ci.yml (the V= of its step \"gitleaks on the new commits\"), so this gitleaks (${GL_HAVE:-its version unknown}) was not checked against it."
  elif [ "$GL_HAVE" != "$GL_PIN" ]; then
    echo "• gitleaks here is ${GL_HAVE:-of a version it does not say}, but CI's secrets job runs $GL_PIN (.github/workflows/ci.yml): their default rules can differ, so the tree may pass here and not there, or the other way. Install gitleaks $GL_PIN to scan as CI does."
  fi
  printf '%s\n' '{{- range . }}{{ .File }}:{{ .StartLine }}: {{ .RuleID }}{{ if .Commit }} (commit {{ printf "%.12s" .Commit }}){{ end }}' '{{ end -}}' > "$SCAN/found.tmpl"
  CFG=()
  if git show origin/main:.gitleaks.toml > "$SCAN/gitleaks.toml" 2>/dev/null || git show HEAD:.gitleaks.toml > "$SCAN/gitleaks.toml" 2>/dev/null; then
    CFG=(--config "$SCAN/gitleaks.toml")
  fi
  scanned() {   # scanned WHAT EXIT LOG REPORT: 3 is a hit; any other failure is a scan that did not run
    [ "$2" = 0 ] && return 0
    [ "$2" = 3 ] || die "gitleaks could not scan $1, so nothing was pushed: $(tail -n 3 "$3" | sed $'s/\033\\[[0-9;]*m//g' | tr '\n' ' ')(update gitleaks, or uninstall it to land without the scan)."
    die "gitleaks found what CI's secrets job will refuse, in $1, so nothing was pushed:
$(sed 's#^tree/##; s/^/  /' "$4")
Change the value (a made-up one must not look like a key either), commit, and land again."
  }
  RC=0
  # Never a config of one's own from the environment: with neither main nor
  # this change holding one, the default rules, as for the tree.
  env -u GITLEAKS_CONFIG -u GITLEAKS_CONFIG_TOML gitleaks git --log-opts="origin/main..HEAD" ${CFG[@]+"${CFG[@]}"} --redact --no-banner --exit-code 3 \
    --report-format template --report-template "$SCAN/found.tmpl" --report-path "$SCAN/commits.txt" >"$SCAN/commits.log" 2>&1 || RC=$?
  scanned "the new commits" "$RC" "$SCAN/commits.log" "$SCAN/commits.txt"
  mkdir -p "$SCAN/dir/tree"
  git archive HEAD | tar -x -C "$SCAN/dir/tree"
  RC=0
  (cd "$SCAN/dir" && env -u GITLEAKS_CONFIG -u GITLEAKS_CONFIG_TOML gitleaks dir . --redact --no-banner --exit-code 3 \
    --report-format template --report-template "$SCAN/found.tmpl" --report-path "$SCAN/tree.txt") >"$SCAN/tree.log" 2>&1 || RC=$?
  scanned "the tree (gitleaks' default rules)" "$RC" "$SCAN/tree.log" "$SCAN/tree.txt"
  echo "✓ gitleaks: nothing in the new commits or the tree, as CI's secrets job scans them"
else
  echo "• gitleaks is not installed, so the secrets scan CI runs was skipped here (CI still runs it)."
fi

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
  [ "$WAIT" = 1 ] || { echo "  Not waiting for it: once it has merged, git pull --rebase."; exit 0; }
else
  # The merge below is the only one on this path: leaving "landed" here left the
  # pull request open for good, with the caller believing otherwise (HB-0439).
  [ "$WAIT" = 1 ] || die "Nothing will merge $URL by itself (no auto-merge here), and --no-wait does not stay to do it. Once its checks pass: gh pr merge $URL --repo $SLUG --rebase --delete-branch, then git pull --rebase." 3
  echo "→ $URL: merging it (rebase) here once every check has passed"
fi

fail() {   # fail MESSAGE — nothing may merge later behind the caller's back
  local now
  [ "$AUTO" = 0 ] || gh pr merge "$URL" --repo "$SLUG" --disable-auto >/dev/null 2>&1 || true
  gh pr close "$URL" --repo "$SLUG" --delete-branch >/dev/null 2>&1 || true
  # Closed only when GitHub says so: with both requests refused (an outage, a
  # token without the right) this said "closed" of a pull request still open
  # with auto-merge on, which GitHub could merge later (audit #046).
  now="$(gh pr view "$URL" --repo "$SLUG" --json state,autoMergeRequest -q '.state + " " + (if .autoMergeRequest then "auto" else "noauto" end)' 2>/dev/null || echo UNKNOWN)"
  case "$now" in
    CLOSED*) die "$1 — the pull request is closed and its branch deleted; the commits stay on local main: fix, commit, and land again." 1 ;;
    MERGED*) die "$1 — but GitHub merged the pull request meanwhile ($URL): git pull --rebase, then fix it on main." 3 ;;
    "OPEN auto") now="still open, with auto-merge on: it can still merge by itself" ;;
    OPEN*) now="still open" ;;
    *) now="not confirmed closed (GitHub did not say)" ;;
  esac
  die "$1 — and closing the pull request failed: $URL is $now. Close it: gh pr close $URL --repo $SLUG --delete-branch (the commits stay on local main)." 3
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
