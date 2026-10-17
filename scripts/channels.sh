#!/usr/bin/env bash
# Print where each release channel points, what this machine runs, and every release.
#   ./scripts/channels.sh        # the newest 20 releases
#   ./scripts/channels.sh all    # every release
#
# The channels and the published releases are the public repo's (the remote
# `public`, read only; origin when there is none): a release tagged in the
# dev repo is marked "not published" until the publisher has pushed it.
# The public repo's tags are listed, never fetched: each has the same name
# as the dev tag it was published from, but is another object.
set -euo pipefail
cd "$(dirname "$0")/.."
PUB="${HATCHABOT_PUBLIC_REMOTE:-public}"
git remote get-url "$PUB" >/dev/null 2>&1 || PUB=origin
git fetch -q --tags --force origin main 2>/dev/null || echo "(offline — showing what this clone already knows)"
[ "$PUB" = origin ] || git fetch -q --no-tags "$PUB" "+refs/heads/main:refs/remotes/$PUB/main" 2>/dev/null || true
PUBLISHED=" $(git ls-remote --tags "$PUB" 'refs/tags/v*' 2>/dev/null | sed -nE 's#.*refs/tags/(v[^^]+)$#\1#p' | tr '\n' ' ') "

chan() { git show "$PUB/main:channels.json" 2>/dev/null | sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"(v[^\"]+)\".*/\1/p" | sed -n 1p; }
STABLE="$(chan stable)"; BETA="$(chan beta)"
LATEST="$(printf '%s\n' $PUBLISHED | grep -E '^v[0-9]' | grep -vE -- '-(rc|beta|alpha)' | sort -rV | sed -n 1p)"
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
  case "$PUBLISHED" in *" $tag "*) ;; "  ") ;; *) marks="$marks not-published" ;; esac
  subject="${subject% (v*)}"
  printf '  %-9s %s  %-32s %.60s\n' "$tag" "$date" "${marks:+←${marks}}" "$subject"
done
TOTAL="$(git tag -l 'v[0-9]*' | wc -l | tr -d ' ')"
[ "$LIMIT" -lt "$TOTAL" ] && echo "  … $((TOTAL - LIMIT)) older — ./scripts/channels.sh all"
exit 0
