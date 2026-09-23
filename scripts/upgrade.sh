#!/usr/bin/env bash
# Upgrade THIS machine's Hatchabot to the newest release on its channel.
#
#   hatchabot upgrade              # along the channel it was installed on (stable by default)
#   hatchabot upgrade beta         # switch channel (stable | beta | latest) and upgrade
#   hatchabot upgrade v2.31.3      # exactly that release — also how you roll back
#
# Same resolution as the installer: stable and beta are named in channels.json
# on main, latest is the newest tag. A channel only ever moves forward; naming a
# version is how to go back. If the new release does not come up, the previous
# one is restored.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$PWD"

# Checking out a release replaces this file while bash is still reading it.
if [ -z "${HATCHABOT_UPGRADE_COPY:-}" ]; then
  tmp="$(mktemp)"; cp "$0" "$tmp"
  HATCHABOT_UPGRADE_COPY="$tmp" HATCHABOT_UPGRADE_DIR="$DIR" exec bash "$tmp" "$@"
fi
trap 'rm -f "$HATCHABOT_UPGRADE_COPY"' EXIT
DIR="$HATCHABOT_UPGRADE_DIR"; cd "$DIR"

CHANNEL_FILE="$HOME/.config/hatchabot/channel"
ARG="${1:-}"
CHANNEL="$ARG"
[ -z "$CHANNEL" ] && [ -f "$CHANNEL_FILE" ] && CHANNEL="$(tr -d '[:space:]' < "$CHANNEL_FILE")"
CHANNEL="${CHANNEL:-stable}"

git fetch --tags --force --quiet origin
# The newer of two versions. `sort -V` alone ranks v2.35.0-beta.1 ABOVE v2.35.0,
# which stranded a beta tester on the prerelease; "~" sorts below everything.
vernewer() { printf '%s\n%s\n' "$1" "$2" | sed 's/-/~/' | sort -V | tail -1 | sed 's/~/-/'; }
newest() { git tag -l 'v[0-9]*' --sort=-v:refname | grep -vE -- '-(rc|beta|alpha)' | head -1; }
case "$CHANNEL" in
  latest) TARGET="$(newest)" ;;
  stable|beta) TARGET="$(git show origin/main:channels.json 2>/dev/null | sed -nE "s/.*\"$CHANNEL\"[[:space:]]*:[[:space:]]*\"(v[^\"]+)\".*/\1/p" | head -1)"
    [ -n "$TARGET" ] || TARGET="$(newest)" ;;
  v[0-9]*) git rev-parse -q --verify "refs/tags/$CHANNEL" >/dev/null || { echo "There is no release $CHANNEL."; exit 1; }
    TARGET="$CHANNEL" ;;
  *) echo "Unknown channel '$CHANNEL' — use stable, beta, latest, or a version like v2.31.3."; exit 1 ;;
esac

# A channel asked for by name is remembered, so the next plain upgrade follows it
# — even when there is nothing to install today.
case "$ARG" in stable|beta|latest) mkdir -p "$(dirname "$CHANNEL_FILE")"; echo "$ARG" > "$CHANNEL_FILE" ;; esac

CUR="$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)"
if [ "$CUR" = "$TARGET" ]; then echo "Already on $TARGET ($CHANNEL)."; exit 0; fi
case "$CHANNEL" in v[0-9]*) ;; *)
  # A channel never takes a machine backwards (this one may run ahead of it).
  if [[ "$CUR" == v* ]] && [ "$(vernewer "$CUR" "$TARGET")" = "$CUR" ]; then
    echo "On $CUR, which is newer than $CHANNEL ($TARGET). Nothing to do — name a version to go back."; exit 0
  fi ;;
esac
if [ -n "$(git status --porcelain)" ]; then
  echo "$DIR has local changes — an upgrade would overwrite them. Refusing:"; git status --porcelain | sed 's/^/    /'; exit 2
fi

RESTART="${HATCHABOT_RESTART_CMD:-./scripts/restart.sh}"   # overridable for tests only
INSTALL="${HATCHABOT_INSTALL_CMD:-npm ci --silent}"         # (likewise)
echo "Upgrading $CUR → $TARGET ($CHANNEL)…"
# `npm ci` deletes node_modules before installing, so a registry outage or a
# full disk used to leave the machine with NO dependencies (and the rollback's
# own npm ci failing under the same fault). Keep the working tree aside until
# the new one is in.
rm -rf node_modules.prev; [ -d node_modules ] && mv node_modules node_modules.prev
restore_deps() { rm -rf node_modules; [ -d node_modules.prev ] && mv node_modules.prev node_modules; return 0; }
rollback() { echo "Rolling back to $CUR…"; git checkout --quiet "$CUR" && restore_deps && $RESTART; }
git checkout --quiet "$TARGET"
# Exit 3: the install step failed (usually transient) and the old release is back untouched.
$INSTALL || { rollback; exit 3; }
$RESTART || { rollback; exit 1; }
rm -rf node_modules.prev
echo "Now on $TARGET."
