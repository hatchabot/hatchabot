#!/usr/bin/env bash
# Print where each release channel points, what this machine runs, and every release.
#   ./scripts/channels.sh        # the newest 20 releases
#   ./scripts/channels.sh all    # every release
set -euo pipefail
cd "$(dirname "$0")/.."
git fetch -q --tags --force origin main 2>/dev/null || echo "(offline — showing what this clone already knows)"

chan() { git show origin/main:channels.json 2>/dev/null | grep "\"$1\"" | sed -E 's/.*"(v[^"]+)".*/\1/' | head -1; }
STABLE="$(chan stable)"; BETA="$(chan beta)"
LATEST="$(git tag -l 'v[0-9]*' --sort=-v:refname | grep -vE -- '-(rc|beta|alpha)' | head -1)"
PROD_DIR="${HATCHABOT_PROD_DIR:-$HOME/hatchabot-prod}"
HERE=""; [ -d "$PROD_DIR/.git" ] && HERE="$(git -C "$PROD_DIR" describe --tags --exact-match 2>/dev/null || true)"

printf '  %-8s %s\n' stable "${STABLE:-(not set)}" beta "${BETA:-(not set)}" latest "${LATEST:-(no tags)}"
[ -n "$HERE" ] && printf '  %-8s %s  (%s)\n' "this box" "$HERE" "$PROD_DIR"
echo

LIMIT=20; [ "${1:-}" = "all" ] && LIMIT=100000
git for-each-ref --sort=-v:refname --count="$LIMIT" --format='%(refname:short)|%(creatordate:short)|%(subject)' 'refs/tags/v[0-9]*' |
while IFS='|' read -r tag date subject; do
  marks=""
  [ "$tag" = "$STABLE" ] && marks="$marks stable"
  [ "$tag" = "$BETA" ] && marks="$marks beta"
  [ "$tag" = "$LATEST" ] && marks="$marks latest"
  [ "$tag" = "$HERE" ] && marks="$marks this-box"
  subject="${subject% (v*)}"
  printf '  %-9s %s  %-32s %.60s\n' "$tag" "$date" "${marks:+←${marks}}" "$subject"
done
TOTAL="$(git tag -l 'v[0-9]*' | wc -l | tr -d ' ')"
[ "$LIMIT" -lt "$TOTAL" ] && echo "  … $((TOTAL - LIMIT)) older — ./scripts/channels.sh all"
exit 0
