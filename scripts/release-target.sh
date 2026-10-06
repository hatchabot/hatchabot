#!/usr/bin/env bash
# Print the release a channel names now (the installer, upgrade.sh and
# follow-channel.sh resolve channels the same way):
#
#   scripts/release-target.sh stable|beta|latest|vX.Y.Z
#
# stable and beta are named in channels.json on main; latest is the newest
# release; a version is itself. A git checkout reads its own clone (fetching
# first); a bundle install has no clone and asks GitHub instead.
set -euo pipefail
cd "$(dirname "$0")/.."
CHANNEL="${1:?usage: release-target.sh stable|beta|latest|vX.Y.Z}"
SLUG="${HATCHABOT_SLUG:-hatchabot/hatchabot}"
from_channels() { sed -nE "s/.*\"$CHANNEL\"[[:space:]]*:[[:space:]]*\"(v[^\"]+)\".*/\1/p" | sed -n 1p; }
if [ -d .git ]; then
  git fetch --tags --force --quiet origin
  newest() { git tag -l 'v[0-9]*' --sort=-v:refname | grep -vE -- '-(rc|beta|alpha)' | sed -n 1p; }  # sed, not head: head closes the pipe early and pipefail makes that exit 141
  case "$CHANNEL" in
    latest) newest ;;
    stable|beta) t="$(git show origin/main:channels.json 2>/dev/null | from_channels)"; [ -n "$t" ] && echo "$t" || newest ;;
    v[0-9]*) git rev-parse -q --verify "refs/tags/$CHANNEL" >/dev/null || { echo "There is no release $CHANNEL." >&2; exit 1; }; echo "$CHANNEL" ;;
    *) echo "Unknown channel '$CHANNEL' — use stable, beta, latest, or a version like v2.31.3." >&2; exit 1 ;;
  esac
else
  newest() { curl -fsSL "https://api.github.com/repos/$SLUG/releases/latest" 2>/dev/null | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"(v[^"]+)".*/\1/p' | sed -n 1p; }
  case "$CHANNEL" in
    latest) newest ;;
    stable|beta) t="$(curl -fsSL "https://raw.githubusercontent.com/$SLUG/main/channels.json" 2>/dev/null | from_channels)"; [ -n "$t" ] && echo "$t" || newest ;;
    v[0-9]*) echo "$CHANNEL" ;;
    *) echo "Unknown channel '$CHANNEL' — use stable, beta, latest, or a version like v2.31.3." >&2; exit 1 ;;
  esac
fi
