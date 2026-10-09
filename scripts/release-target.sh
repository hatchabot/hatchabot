#!/usr/bin/env bash
# Print the release a channel names now (the installer, upgrade.sh and
# follow-channel.sh resolve channels the same way):
#
#   scripts/release-target.sh stable|beta|latest|vX.Y.Z
#
# stable and beta are named in channels.json on main; latest is the newest
# release; a version is itself. A git checkout reads its own clone (fetching
# first); a bundle install has no clone and asks GitHub instead.
#
# Exit 1: no such channel or release (asked wrongly). Exit 3: it could not
# find out — no network, or an answer that is not a channels file (a captive
# portal's page). Until 2026-10-09 a failed fetch ended this with git's or
# curl's own code, and a portal's page read as "stable is not named" and gave
# the NEWEST release instead.
set -euo pipefail
cd "$(dirname "$0")/.."
CHANNEL="${1:?usage: release-target.sh stable|beta|latest|vX.Y.Z}"
SLUG="${HATCHABOT_SLUG:-hatchabot/hatchabot}"
from_channels() { sed -nE "s/.*\"$CHANNEL\"[[:space:]]*:[[:space:]]*\"(v[^\"]+)\".*/\1/p" | sed -n 1p; }
# A channels file is a JSON object; a portal's or proxy's page is not.
is_channels() { printf '%s' "$1" | tr -d '[:space:]' | grep -E '^\{.*"(stable|beta)":.*\}$' >/dev/null; }
cant() { echo "$*" >&2; exit 3; }
# The channel's release from a channels file. Not named: beta falls back to
# the newest release; stable never does — it is what strangers install.
named() {
  local json="$1" t
  is_channels "$json" || cant "The answer for channels.json is not a channels file (a captive portal or proxy?) — try again later."
  t="$(printf '%s\n' "$json" | from_channels)"
  if [ -n "$t" ]; then echo "$t"; return 0; fi
  [ "$CHANNEL" = stable ] && cant "channels.json names no stable release — try again later."
  newest
}
if [ -d .git ]; then
  git fetch --tags --force --quiet origin || cant "Could not fetch the releases from origin (no network?)."
  newest() { git tag -l 'v[0-9]*' --sort=-v:refname | grep -vE -- '-(rc|beta|alpha)' | sed -n 1p; }  # sed, not head: head closes the pipe early and pipefail makes that exit 141
  case "$CHANNEL" in
    latest) newest ;;
    stable|beta) named "$(git show origin/main:channels.json 2>/dev/null || true)" ;;
    v[0-9]*) git rev-parse -q --verify "refs/tags/$CHANNEL" >/dev/null || { echo "There is no release $CHANNEL." >&2; exit 1; }; echo "$CHANNEL" ;;
    *) echo "Unknown channel '$CHANNEL' — use stable, beta, latest, or a version like v2.31.3." >&2; exit 1 ;;
  esac
else
  newest() {
    local j
    j="$(curl -fsSL "https://api.github.com/repos/$SLUG/releases/latest" 2>/dev/null)" || cant "Could not ask GitHub for the newest release (no network?)."
    printf '%s\n' "$j" | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"(v[^"]+)".*/\1/p' | sed -n 1p
  }
  case "$CHANNEL" in
    latest) newest ;;
    stable|beta)
      J="$(curl -fsSL "https://raw.githubusercontent.com/$SLUG/main/channels.json" 2>/dev/null)" || cant "Could not fetch channels.json from GitHub (no network?)."
      named "$J" ;;
    v[0-9]*) echo "$CHANNEL" ;;
    *) echo "Unknown channel '$CHANNEL' — use stable, beta, latest, or a version like v2.31.3." >&2; exit 1 ;;
  esac
fi
