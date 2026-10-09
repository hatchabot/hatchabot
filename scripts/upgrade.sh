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
#
# Exit codes (follow-channel.sh reads them): 0 upgraded, or nothing to do;
# 1 the new release did not come up and the previous one is back — the ONLY
# code that means "this release is bad, do not retry it"; 2 refused (local
# changes, no such channel or release); 3 did not complete (no network, an
# install that failed) with the previous release back as it was — try again;
# 4 another upgrade is running.
set -euo pipefail
[ -x "$(dirname "$0")/../.node/bin/node" ] && PATH="$(cd "$(dirname "$0")/.." && pwd)/.node/bin:$PATH" && export PATH  # a bundle install's own Node (install.sh)
cd "$(dirname "$0")/.."
DIR="$PWD"

# Checking out a release replaces this file while bash is still reading it.
if [ -z "${HATCHABOT_UPGRADE_COPY:-}" ]; then
  tmp="$(mktemp)"; cp "$0" "$tmp"
  HATCHABOT_UPGRADE_COPY="$tmp" HATCHABOT_UPGRADE_DIR="$DIR" exec bash "$tmp" "$@"
fi
DIR="$HATCHABOT_UPGRADE_DIR"; cd "$DIR"

# Whatever ends this script ends here. A failure the script did not plan for
# (set -e after node_modules was moved aside, a failed mv in the bundle swap)
# used to leave a half-changed tree and exit 1 — which follow-channel.sh reads
# as "the release did not start", so it never tried that release again
# (review, 2026-10-09). Now the previous release is put back, and only an
# explicit rollback says 1.
ROLLED_BACK=0   # 1 once the new release was tried and did not come up
CHANGING=0      # 1 while the tree is part-way between two releases
RESTARTED=0     # 1 once the service was restarted onto the new release
LOCK=""; STAGE=""
undo() { :; }   # set below, per kind of install
finish() {
  local rc=$?
  set +e
  if [ "$rc" != 0 ] && [ "$CHANGING" = 1 ]; then
    CHANGING=0; rc=3; echo "The upgrade stopped part-way — putting ${CUR:-the previous release} back."; undo
  fi
  [ -z "$LOCK" ] || rmdir "$LOCK" 2>/dev/null
  rm -f "$HATCHABOT_UPGRADE_COPY"; [ -z "$STAGE" ] || rm -rf "$STAGE"
  case "$rc" in 0|2|3|4) ;; 1) [ "$ROLLED_BACK" = 1 ] || rc=3 ;; *) rc=3 ;; esac
  exit "$rc"
}
trap finish EXIT

CHANNEL_FILE="$HOME/.config/hatchabot/channel"
ARG="${1:-}"
CHANNEL="$ARG"
[ -z "$CHANNEL" ] && [ -f "$CHANNEL_FILE" ] && CHANNEL="$(tr -d '[:space:]' < "$CHANNEL_FILE")"
CHANNEL="${CHANNEL:-stable}"

# A bundle install (install.sh) has no clone: it upgrades by swapping in the
# next release's bundle (below), and resolves channels without git.
BUNDLED=0; [ -f BUNDLE.json ] && [ ! -d .git ] && BUNDLED=1
# The newer of two versions. `sort -V` alone ranks v2.35.0-beta.1 ABOVE v2.35.0,
# which stranded a beta tester on the prerelease; "~" sorts below everything.
vernewer() { printf '%s\n%s\n' "$1" "$2" | sed 's/-/~/' | sort -V | tail -1 | sed 's/~/-/'; }
# release-target.sh: 1 = no such channel or release (it says which), anything
# else = it could not find out (no network, an answer that is not a channels
# file). Neither is the release failing: `|| exit 1` here once got releases
# that were never tried blacklisted by the channel timer (review, 2026-10-09).
TARGET="$("$DIR/scripts/release-target.sh" "$CHANNEL")" || { [ "$?" = 1 ] && exit 2; echo "Could not find which release $CHANNEL names now — try again later."; exit 3; }
[ -n "$TARGET" ] || { echo "Could not find which release $CHANNEL names (no network to github.com?)."; exit 3; }

# A channel asked for by name is remembered, so the next plain upgrade follows it
# — even when there is nothing to install today. Not when the channel timer
# asks (follow-channel.sh): it named its own channel, and writing that undid a
# `hatchabot upgrade beta` within ten minutes (review, 2026-10-09).
if [ "${HATCHABOT_UPGRADE_BY_TIMER:-}" != 1 ]; then
case "$ARG" in stable|beta|latest) mkdir -p "$(dirname "$CHANNEL_FILE")"; echo "$ARG" > "$CHANNEL_FILE" ;; esac
# A version named by hand is a pin: the channel timer leaves this machine
# alone until a channel is named again (a rollback used to be undone within
# ten minutes; use-case audit, 2026-09-27).
case "$ARG" in v[0-9]*) mkdir -p "$(dirname "$CHANNEL_FILE")"; echo "$ARG" > "$CHANNEL_FILE"
  echo "Pinned to $ARG — automatic upgrades pause here. Follow a channel again with: hatchabot upgrade stable" ;; esac
fi

if [ "$BUNDLED" = 1 ]; then CUR="$(sed -nE 's/.*"tag":"([^"]+)".*/\1/p' BUNDLE.json)"
else CUR="$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)"; fi
if [ "$CUR" = "$TARGET" ]; then echo "Already on $TARGET ($CHANNEL)."; exit 0; fi
case "$CHANNEL" in v[0-9]*) ;; *)
  # A channel never takes a machine backwards (this one may run ahead of it).
  if [[ "$CUR" == v* ]] && [ "$(vernewer "$CUR" "$TARGET")" = "$CUR" ]; then
    echo "On $CUR, which is newer than $CHANNEL ($TARGET). Nothing to do — name a version to go back."; exit 0
  fi ;;
esac
if [ "$BUNDLED" = 0 ] && [ -n "$(git status --porcelain)" ]; then
  echo "$DIR has local changes — an upgrade would overwrite them. Refusing:"; git status --porcelain | sed 's/^/    /'; exit 2
fi

# One upgrade at a time: the channel timer and a hand-run upgrade used to race
# each other's node_modules.prev (30th audit). The lock lives outside the tree
# (an untracked file here would read as a local change next time).
# The lock is a directory (mkdir is atomic everywhere; macOS has no flock — the
# first version of this refused every Mac upgrade, 2026-09-27). A lock older
# than an hour is a crash's leftover, not a running upgrade. It is in this
# user's own state folder, not /tmp: on a shared host anyone could make the
# /tmp name first and stop every upgrade (review, 2026-10-09).
LOCKS="${XDG_STATE_HOME:-$HOME/.local/state}/hatchabot"; mkdir -p "$LOCKS"
LOCK_PATH="$LOCKS/upgrade-$(printf %s "$DIR" | cksum | cut -d' ' -f1).lock.d"
if [ -d "$LOCK_PATH" ] && [ -n "$(find "$LOCK_PATH" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then rmdir "$LOCK_PATH" 2>/dev/null || true; fi
mkdir "$LOCK_PATH" 2>/dev/null || { echo "Another upgrade of $DIR is running (lock $LOCK_PATH)."; exit 4; }
LOCK="$LOCK_PATH"
RESTART="${HATCHABOT_RESTART_CMD:-./scripts/restart.sh}"   # overridable for tests only
# ensure-deps writes the stamp restart.sh checks: a bare `npm ci` left none,
# so restart.sh installed everything a second time, and a registry blip on
# that second run failed (and blacklisted) a good release (night review).
INSTALL="${HATCHABOT_INSTALL_CMD:-./scripts/ensure-deps.sh --quiet}"   # (likewise)
echo "Upgrading $CUR → $TARGET ($CHANNEL)…"
if [ "$BUNDLED" = 1 ]; then
  # The next release's bundle beside this install: downloaded, its hash checked,
  # unpacked and self-checked before anything here moves. Then the code is
  # swapped — only the bundle's own top-level files (its .bundle-files), so
  # .env, data/ and backups stay — with the old ones kept until the new
  # release is up; if it does not come up, they go back.
  PLATFORM="$(sed -nE 's/.*"platform":"([^"]+)".*/\1/p' BUNDLE.json)"
  NAME="hatchabot-$TARGET-$PLATFORM.tar.gz"
  BASE="${HATCHABOT_BUNDLE_BASE:-https://github.com/${HATCHABOT_SLUG:-hatchabot/hatchabot}/releases/download}"
  STAGE="$(mktemp -d "$(dirname "$DIR")/.hatchabot-next-XXXXXX")"
  sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
  curl -fsSL --retry 3 -o "$STAGE/$NAME" "$BASE/$TARGET/$NAME" || { echo "No bundle for $TARGET on $PLATFORM yet — try again later."; exit 3; }
  # Its own message: under pipefail a failed fetch here ended the script with curl's code and no word.
  WANT="$(curl -fsSL --retry 3 "$BASE/$TARGET/$NAME.sha256" 2>/dev/null | cut -d' ' -f1)" || { echo "Could not fetch the $TARGET bundle's checksum — try again later."; exit 3; }
  [ -n "$WANT" ] && [ "$WANT" = "$(sha "$STAGE/$NAME")" ] || { echo "The $TARGET bundle's checksum does not match — not installing it."; exit 3; }
  tar -xzf "$STAGE/$NAME" -C "$STAGE" || { echo "Could not unpack the $TARGET bundle."; exit 3; }
  NEW="$STAGE/hatchabot"
  ( cd "$NEW" && ./.node/bin/node -e 'new (require("better-sqlite3"))(":memory:").exec("SELECT 1")' ) >/dev/null 2>&1 || { echo "The $TARGET bundle does not run on this machine — staying on $CUR."; exit 3; }
  # A bundle from before the file list: what it holds is what it has.
  [ -f "$NEW/.bundle-files" ] || ( cd "$NEW" && ls -A > .bundle-files )
  [ -f .bundle-files ] || ls -A "$NEW" > .bundle-files.guess
  OLDLIST="$( [ -f .bundle-files ] && cat .bundle-files || cat .bundle-files.guess )"; rm -f .bundle-files.guess
  PREV="$DIR/.prev-release"
  rm -rf "$PREV"; mkdir -p "$PREV"
  # What came in from the new bundle, one name a line: a swap that stops
  # part-way (a failed mv) is undone from this and $PREV, not from a file list
  # that may itself be half moved.
  MOVED_IN=""
  rollback_bundle() {
    echo "Rolling back to ${CUR}…"
    while IFS= read -r f; do [ -n "$f" ] && rm -rf "${DIR:?}/$f"; done <<< "$MOVED_IN"
    for f in "$PREV"/* "$PREV"/.[!.]*; do [ -e "$f" ] && mv "$f" "$DIR/"; done
    rm -rf "$PREV"
    # The old release's restart, on its own Node — only when the service was
    # restarted onto the new one; otherwise the old release never stopped.
    if [ "$RESTARTED" = 1 ]; then PATH="$DIR/.node/bin:$PATH" "$DIR/scripts/restart.sh"; fi
    return 0
  }
  undo() { rollback_bundle; }
  CHANGING=1
  while IFS= read -r f; do
    [ -n "$f" ] && [ -e "$DIR/$f" ] || continue
    mv "$DIR/$f" "$PREV/" || { echo "Could not move $DIR/$f aside."; exit 3; }
  done <<< "$OLDLIST"
  while IFS= read -r f; do
    [ -n "$f" ] && [ -e "$NEW/$f" ] || continue
    mv "$NEW/$f" "$DIR/" || { echo "Could not move the new $f into $DIR."; exit 3; }
    MOVED_IN="$MOVED_IN$f"$'\n'
  done < "$NEW/.bundle-files"
  RESTARTED=1
  PATH="$DIR/.node/bin:$PATH" "$DIR/scripts/restart.sh" || { CHANGING=0; ROLLED_BACK=1; rollback_bundle || true; exit 1; }
  CHANGING=0
  rm -rf "$PREV"
  echo "Now on $TARGET."
else
# `npm ci` deletes node_modules before installing, so a registry outage or a
# full disk used to leave the machine with NO dependencies (and the rollback's
# own npm ci failing under the same fault). Keep the working tree aside until
# the new one is in.
restore_deps() { rm -rf node_modules; [ -d node_modules.prev ] && mv node_modules.prev node_modules; return 0; }
# The service is restarted only if it was restarted onto the new release: an
# install that failed left the old one running, and restarting it anyway
# restarted production every ten minutes while a release that cannot install
# kept failing (review, 2026-10-09).
rollback() {
  echo "Rolling back to ${CUR}…"
  git checkout --quiet "$CUR" && restore_deps || return 1
  if [ "$RESTARTED" = 1 ]; then $RESTART; fi
}
undo() { rollback; }
CHANGING=1
rm -rf node_modules.prev; [ -d node_modules ] && mv node_modules node_modules.prev
git checkout --quiet "$TARGET"
# Exit 3: the install step failed (usually transient) and the old release is back untouched.
$INSTALL || { CHANGING=0; rollback || true; exit 3; }
RESTARTED=1
$RESTART || { CHANGING=0; ROLLED_BACK=1; rollback || true; exit 1; }
CHANGING=0
rm -rf node_modules.prev
echo "Now on $TARGET."
fi

# The runtime image this release defaults to (OpenClaw X in the Dockerfile),
# if the machine does not have it yet. Until 2026-09-25 an upgrade left the
# image the install had first built — a MacBook on v2.80.0 still ran agents
# on OpenClaw 2026.7.1-2 two releases after 2026.9.6 became "the version
# every install gets". Best effort: a failed pull is a line here, never a
# failed upgrade, and the app's Settings → Images does the same on demand.
if [ "${HATCHABOT_UPGRADE_IMAGE:-1}" = 1 ] && command -v docker >/dev/null 2>&1; then
  WANT="$(sed -n 's/^ARG OPENCLAW_VERSION=//p' docker/Dockerfile.runtime | sed -n 1p)"
  HAVE="$(docker image inspect hatchabot-runtime:latest --format '{{ index .Config.Labels "org.agentclaw.openclaw-version" }}' 2>/dev/null || true)"
  # Only upwards: a promoted candidate newer than the default stays.
  if [ -n "$WANT" ] && [ "$HAVE" != "$WANT" ] && { [ -z "$HAVE" ] || [ "$(printf '%s\n%s\n' "$HAVE" "$WANT" | sed 's/-/~/' | sort -V | sed -n 1p)" = "$(printf '%s' "$HAVE" | sed 's/-/~/')" ]; }; then
    echo "The runtime image here carries OpenClaw ${HAVE:-nothing}; this release's default is $WANT — fetching it (a few GB; agents move to it on their next rebuild)…"
    ./scripts/build-runtime-image.sh || echo "⚠ Could not fetch the $WANT image now — run ./scripts/build-runtime-image.sh later, or Settings → Images."
  fi
fi
