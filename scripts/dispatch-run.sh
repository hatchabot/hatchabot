#!/usr/bin/env bash
# Start a workflow on main and print the id of the run it made, for
# `gh run watch` (scripts/release.sh, scripts/promote.sh; 2026-10-10).
# `gh workflow run` does not say which run it started: the new run is the
# one that was not in the list just before.
#
#   scripts/dispatch-run.sh <owner/name> <workflow file> [-f key=value]...
#
# Exit 0 with the run id on stdout; 1 when it could not start the workflow
# or find its run within about a minute.
# HATCHABOT_DISPATCH_POLL: seconds between looks (default 2; the tests use 0).
set -euo pipefail
REPO="${1:?usage: dispatch-run.sh <owner/name> <workflow file> [-f key=value]...}"
WF="${2:?usage: dispatch-run.sh <owner/name> <workflow file> [-f key=value]...}"
shift 2
runs() { gh run list --repo "$REPO" --workflow "$WF" --event workflow_dispatch --limit 20 --json databaseId -q '.[].databaseId'; }
BEFORE=" $(runs | tr '\n' ' ') " || { echo "✗ Could not list the runs of $WF." >&2; exit 1; }
gh workflow run "$WF" --repo "$REPO" --ref main "$@" >/dev/null || { echo "✗ Could not start $WF." >&2; exit 1; }
for _ in $(seq 1 30); do
  for id in $(runs 2>/dev/null || true); do
    case "$BEFORE" in *" $id "*) ;; *) echo "$id"; exit 0 ;; esac
  done
  sleep "${HATCHABOT_DISPATCH_POLL:-2}"
done
echo "✗ Started $WF but could not find its run: https://github.com/$REPO/actions/workflows/$WF" >&2
exit 1
