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
ASIDE=0         # 1 once a git install's node_modules was moved aside
SERVING=0       # 1 once the new release is up: only tidying is left
LOCK=""; STAGE=""
undo() { :; }   # set below, per kind of install
finish() {
  local rc=$?
  set +e
  if [ "$rc" != 0 ] && [ "$CHANGING" = 1 ]; then
    CHANGING=0; rc=3; echo "The upgrade stopped part-way — putting ${CUR:-the previous release} back."; undo
  fi
  # Stopped once the new release was up (removing what it replaced, fetching
  # the runtime image): it is upgraded, not a failure to try again (HB-0266).
  # What was half removed goes with the next upgrade.
  if [ "$SERVING" = 1 ]; then rm -f "$SWAPPING" "$FROM_FILE"; rc=0; fi
  # Only its holder lets it go: a lock cleared and taken by another run is theirs.
  [ -z "$LOCK" ] || [ "$(cat "$LOCK/owner" 2>/dev/null)" != "$ME" ] || rm -rf "$LOCK"
  rm -f "$HATCHABOT_UPGRADE_COPY"; [ -z "$STAGE" ] || rm -rf "$STAGE"
  case "$rc" in 0|2|3|4) ;; 1) [ "$ROLLED_BACK" = 1 ] || rc=3 ;; *) rc=3 ;; esac
  exit "$rc"
}
trap finish EXIT
# Stopped by a signal (Ctrl-C, `systemctl stop`, a closed terminal), bash
# ended without running finish: an upgrade cut off in `npm ci` left the tree
# on the new release with half its dependencies, and the next run said
# "Already on" it (HB-0043). Ended through exit, finish puts the old one back.
trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP

# The channel chosen last is this install's own, in data/channel (HB-0235):
# the one file in ~/.config/hatchabot was every install's of the user's, so
# `hatchabot upgrade beta` in a test clone moved the production install's
# timer onto beta. That file is still read when this install has none of its
# own, and still written for a release from before v2.169.0, the only one it
# reads (remember_channel). install.sh and follow-channel.sh do the same.
CHANNEL_FILE="$DIR/data/channel"; USER_CHANNEL_FILE="$HOME/.config/hatchabot/channel"; PER_INSTALL_FROM=v2.169.0
remembered_channel() { local f; for f in "$CHANNEL_FILE" "$USER_CHANNEL_FILE"; do [ -f "$f" ] && { tr -d '[:space:]' < "$f"; return 0; }; done; return 0; }
ARG="${1:-}"
CHANNEL="$ARG"
[ -n "$CHANNEL" ] || CHANNEL="$(remembered_channel)"
CHANNEL="${CHANNEL:-stable}"

# A bundle install (install.sh) has no clone: it upgrades by swapping in the
# next release's bundle (below), and resolves channels without git.
# (Or a swap that was cut off, which may have moved BUNDLE.json aside: below.)
BUNDLED=0; { [ -f BUNDLE.json ] || [ -f .swapping ]; } && [ ! -d .git ] && BUNDLED=1
# The newer of two versions. `sort -V` alone ranks v2.35.0-beta.1 ABOVE v2.35.0,
# which stranded a beta tester on the prerelease; "~" sorts below everything.
vernewer() { printf '%s\n%s\n' "$1" "$2" | sed 's/-/~/' | sort -V | tail -1 | sed 's/~/-/'; }
# release-target.sh: 1 = no such channel or release (it says which), anything
# else = it could not find out (no network, an answer that is not a channels
# file). Neither is the release failing: `|| exit 1` here once got releases
# that were never tried blacklisted by the channel timer (review, 2026-10-09).
# The channel timer (follow-channel.sh) resolved the channel already and
# remembers a failure by that release: it passes it, so the release tried is
# the one it records (audit #042).
if [ -n "${HATCHABOT_UPGRADE_TARGET:-}" ]; then
  case "$HATCHABOT_UPGRADE_TARGET" in v[0-9]*) TARGET="$HATCHABOT_UPGRADE_TARGET" ;; *) echo "Not a release: $HATCHABOT_UPGRADE_TARGET"; exit 2 ;; esac
else
TARGET="$("$DIR/scripts/release-target.sh" "$CHANNEL")" || { [ "$?" = 1 ] && exit 2; echo "Could not find which release $CHANNEL names now — try again later."; exit 3; }
fi
[ -n "$TARGET" ] || { echo "Could not find which release $CHANNEL names (no network to github.com?)."; exit 3; }

# A channel asked for by name is remembered, so the next plain upgrade follows it
# — even when there is nothing to install today. Not when the channel timer
# asks (follow-channel.sh): it named its own channel, and writing that undid a
# `hatchabot upgrade beta` within ten minutes (review, 2026-10-09).
# remember_channel VALUE [RELEASE]: VALUE for this install. RELEASE, the one
# it will run, from before v2.169.0 reads only the user's file: it goes there
# (and this install's own goes, so the two cannot disagree once it is back).
remember_channel() {
  if [ -n "${2:-}" ] && [ "$(vernewer "$2" "$PER_INSTALL_FROM")" != "$2" ]; then
    mkdir -p "$(dirname "$USER_CHANNEL_FILE")"; echo "$1" > "$USER_CHANNEL_FILE"; rm -f "$CHANNEL_FILE"
  else
    mkdir -p "$(dirname "$CHANNEL_FILE")"; echo "$1" > "$CHANNEL_FILE"
  fi
}
if [ "${HATCHABOT_UPGRADE_BY_TIMER:-}" != 1 ]; then
case "$ARG" in stable|beta|latest) remember_channel "$ARG" ;; esac
# A version named by hand is a pin: the channel timer leaves this machine
# alone until a channel is named again (a rollback used to be undone within
# ten minutes; use-case audit, 2026-09-27).
case "$ARG" in v[0-9]*) remember_channel "$ARG" "$ARG"
  echo "Pinned to $ARG — automatic upgrades pause here. Follow a channel again with: hatchabot upgrade stable" ;; esac
fi

# One upgrade at a time: the channel timer and a hand-run upgrade used to race
# each other's node_modules.prev (30th audit). The lock lives outside the tree
# (an untracked file here would read as a local change next time).
# The lock is a directory (mkdir is atomic everywhere; macOS has no flock — the
# first version of this refused every Mac upgrade, 2026-09-27). It is in this
# user's own state folder, not /tmp: on a shared host anyone could make the
# /tmp name first and stop every upgrade (review, 2026-10-09).
# Its holder is written in it (pid and start time: a pid reused since is not
# the holder), and only a holder that is gone makes it a leftover. Age alone
# used to: a slow download past an hour lost its lock to the next run, and two
# upgrades swapped the tree at once (#226). A lock with no holder written
# (from an older release) is still a leftover after an hour. Leftovers are
# cleared under a second lock, judged again once it is held, so two runs
# clearing one leftover cannot remove the lock the first then took.
# deploy-release.sh takes the same lock the same way.
LOCKS="${XDG_STATE_HOME:-$HOME/.local/state}/hatchabot"; mkdir -p "$LOCKS"
LOCK_PATH="$LOCKS/upgrade-$(printf %s "$DIR" | cksum | cut -d' ' -f1).lock.d"
proc_start() { LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//'; }
ME="$$"; MY_START="$(proc_start $$)"; [ -z "$MY_START" ] || ME="$$ $MY_START"
lock_left_over() {
  local owner pid
  owner="$(cat "$LOCK_PATH/owner" 2>/dev/null)" || owner=""
  if [ -z "$owner" ]; then [ -n "$(find "$LOCK_PATH" -maxdepth 0 -mmin +60 2>/dev/null)" ]; return; fi
  pid="${owner%% *}"
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  if [ "$owner" = "$pid" ]; then ! kill -0 "$pid" 2>/dev/null; else [ "$owner" != "$pid $(proc_start "$pid")" ]; fi
}
take_lock() {
  mkdir "$LOCK_PATH" 2>/dev/null || return 1
  LOCK="$LOCK_PATH"
  printf '%s\n' "$ME" > "$LOCK_PATH/owner.$$" && mv -f "$LOCK_PATH/owner.$$" "$LOCK_PATH/owner"
}
if ! take_lock; then
  # Clearing takes milliseconds: a clearing lock this old is a crash's.
  [ -z "$(find "$LOCK_PATH.clearing" -maxdepth 0 -mmin +10 2>/dev/null)" ] || rmdir "$LOCK_PATH.clearing" 2>/dev/null || true
  if [ -d "$LOCK_PATH" ] && lock_left_over && mkdir "$LOCK_PATH.clearing" 2>/dev/null; then
    if lock_left_over; then rm -rf "$LOCK_PATH"; fi
    rmdir "$LOCK_PATH.clearing" 2>/dev/null || true
  fi
  take_lock || { echo "Another upgrade of $DIR is running (lock $LOCK_PATH)."; exit 4; }
fi

# A bundle swap moves the old release's files into .prev-release, then the
# new one's in, one by one. Cut off part-way (SIGKILL, a power cut), it left
# the tree half old, half new; BUNDLE.json was often the new one already, so
# every later run said "Already on vNEW" and the install stayed broken
# (HB-0049). The swap writes .swapping before its first move, and names each
# file in it before moving that file in: the next run puts the previous
# release back first, then upgrades as usual.
SWAPPING="$DIR/.swapping"; PREV="$DIR/.prev-release"
# A name a bundle's file list may not touch: a path, or what is this machine's.
not_ours() { case "$1" in ''|*/*|.|..|.env|data|.swapping|.swapping.tmp|.prev-release) return 0 ;; esac; return 1; }
# Back to the release in .prev-release: the previous files moved back, then
# what else came in from the new bundle removed. Run again after a cut, it
# goes on: each file's `in` line is struck from .swapping before it moves
# back, so one already back is the old release's, never removed as the new
# one's. It was, and a rollback cut off after putting a file back deleted it
# for good (HB-0279). Struck, not marked: an upgrade.sh from before this
# reads only `in` lines, and scripts/ goes back first (cut off, the tree
# holds an upgrade.sh that goes on), so the old one may finish the job.
restore_prev() {
  local line f n
  for f in "$PREV"/scripts "$PREV"/* "$PREV"/.[!.]*; do
    [ -e "$f" ] || continue
    n="${f##*/}"
    # One of that name here, the new one, would take the old one inside
    # itself, a directory in a directory (HB-0071).
    rm -rf "${DIR:?}/$n"
    if [ -f "$SWAPPING" ] && grep -qxF "in $n" "$SWAPPING"; then
      { grep -vxF "in $n" "$SWAPPING" || [ $? = 1 ]; } > "$SWAPPING.tmp" && mv -f "$SWAPPING.tmp" "$SWAPPING" || return 1
    fi
    mv "$f" "$DIR/" || return 1
  done
  # The new release's unpacked bundle, beside the install.
  STAGED="$(sed -n 's/^stage //p' "$SWAPPING" 2>/dev/null | sed -n 1p)"
  case "$STAGED" in "$(dirname "$DIR")"/.hatchabot-next-*) ;; *) STAGED="" ;; esac
  if [ -f "$SWAPPING" ]; then
    while IFS= read -r line; do
      case "$line" in "in "?*) f="${line#in }" ;; *) continue ;; esac
      # Still in the bundle, the new one never moved in: the one here is the
      # old one. An upgrade.sh from before v2.171.0 wrote `in` before moving
      # the old one aside, and a cut in between lost it (HB-0279).
      if [ -n "$STAGED" ] && { [ -e "$STAGED/hatchabot/$f" ] || [ -L "$STAGED/hatchabot/$f" ]; }; then continue; fi
      not_ours "$f" || rm -rf "${DIR:?}/$f"
    done < "$SWAPPING"
  fi
  rm -rf "$PREV"
  # The unpacked bundle goes with it.
  [ -z "$STAGED" ] || rm -rf "$STAGED"
  rm -f "$SWAPPING" "$SWAPPING.tmp"
}
if [ "$BUNDLED" = 1 ] && [ -f "$SWAPPING" ]; then
  echo "An upgrade of $DIR was cut off part-way — putting $(sed -n 's/^from //p' "$SWAPPING" | sed -n 1p) back first."
  WAS_RESTARTED=0; ! grep -qx restarted "$SWAPPING" || WAS_RESTARTED=1
  restore_prev || { echo "Could not put the previous release back (above): $PREV holds its files."; exit 3; }
  # The service was already restarted onto the new release: back onto this one.
  if [ "$WAS_RESTARTED" = 1 ]; then PATH="$DIR/.node/bin:$PATH" "$DIR/scripts/restart.sh" || true; fi
fi

RESTART="${HATCHABOT_RESTART_CMD:-./scripts/restart.sh}"   # overridable for tests only
# A git install's upgrade in progress, beside the lock (in the tree it would
# read as a local change): `from <release>`, then `restarted` once the service
# was restarted onto the new one. Left behind, the run was killed part-way
# (SIGKILL, a power cut): the checkout may be on the new release with half
# its dependencies installed, and the old ones in node_modules.prev. The next
# run puts the old release back first, then upgrades as usual (HB-0043).
FROM_FILE="${LOCK_PATH%.lock.d}.from"
if [ "$BUNDLED" = 0 ] && [ -f "$FROM_FILE" ]; then
  FROM="$(sed -n 's/^from //p' "$FROM_FILE" | sed -n 1p)"
  echo "An upgrade of $DIR was cut off part-way — putting ${FROM:-the previous release} back first."
  { [ -n "$FROM" ] && git checkout --quiet "$FROM"; } || { echo "Could not check out ${FROM:-the previous release} (above): node_modules.prev holds its dependencies."; exit 3; }
  [ ! -d node_modules.prev ] || { rm -rf node_modules; mv node_modules.prev node_modules; }
  if grep -qx restarted "$FROM_FILE"; then $RESTART || true; fi
  rm -f "$FROM_FILE"
fi

# What is installed, read only once the lock is held: read before it, a run
# that waited there while another upgrade moved this machine on judged by the
# release it no longer had, and a channel upgrade took the machine backwards
# (audit #035).
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
  # What the release vouches for (#38): the bundle's size and sha256 as its
  # release-manifest.json names them (scripts/release-manifest.sh, which also
  # keeps the manifest for the runtime image step below). A manifest that is
  # there but unreadable, or for another release, is refused — never passed
  # over for the weaker check. A release made before manifests (before
  # v2.159.0) has none: the .sha256 beside the bundle, as before (legacy).
  MRC=0; "$DIR/scripts/release-manifest.sh" asset "$TARGET" "$STAGE/$NAME" "$NAME" || MRC=$?
  case "$MRC" in
    0) ;;
    10)
      # Its own message: under pipefail a failed fetch here ended the script with curl's code and no word.
      WANT="$(curl -fsSL --retry 3 "$BASE/$TARGET/$NAME.sha256" 2>/dev/null | cut -d' ' -f1)" || { echo "Could not fetch the $TARGET bundle's checksum — try again later."; exit 3; }
      [ -n "$WANT" ] && [ "$WANT" = "$(sha "$STAGE/$NAME")" ] || { echo "The $TARGET bundle's checksum does not match — not installing it."; exit 3; } ;;
    3) echo "Could not fetch the $TARGET release's manifest to check its bundle — try again later."; exit 3 ;;
    *) echo "Not installing the $TARGET bundle: the release's manifest does not vouch for it (above). Staying on $CUR."; exit 3 ;;
  esac
  tar -xzf "$STAGE/$NAME" -C "$STAGE" || { echo "Could not unpack the $TARGET bundle."; exit 3; }
  NEW="$STAGE/hatchabot"
  ( cd "$NEW" && ./.node/bin/node -e 'new (require("better-sqlite3"))(":memory:").exec("SELECT 1")' ) >/dev/null 2>&1 || { echo "The $TARGET bundle does not run on this machine — staying on $CUR."; exit 3; }
  # A bundle from before the file list: what it holds is what it has.
  [ -f "$NEW/.bundle-files" ] || ( cd "$NEW" && ls -A > .bundle-files )
  [ -f .bundle-files ] || ls -A "$NEW" > .bundle-files.guess
  OLDLIST="$( [ -f .bundle-files ] && cat .bundle-files || cat .bundle-files.guess )"; rm -f .bundle-files.guess
  rm -rf "$PREV"; mkdir -p "$PREV"
  # What came in from the new bundle is written in .swapping (above), one name
  # a line, BEFORE it moves: a swap that stops part-way (a failed mv, or this
  # run killed) is undone from that and $PREV, not from a file list that may
  # itself be half moved.
  rollback_bundle() {
    echo "Rolling back to ${CUR}…"
    restore_prev || return 1
    # The old release's restart, on its own Node — only when the service was
    # restarted onto the new one; otherwise the old release never stopped.
    if [ "$RESTARTED" = 1 ]; then PATH="$DIR/.node/bin:$PATH" "$DIR/scripts/restart.sh"; fi
    return 0
  }
  undo() { rollback_bundle; }
  printf 'from %s\nto %s\nstage %s\n' "$CUR" "$TARGET" "$STAGE" > "$SWAPPING"
  CHANGING=1
  # One name at a time, the old one aside and the new one straight in, and
  # scripts/ first: cut off, the tree is short at most the one name being
  # swapped, and holds the new upgrade.sh that repairs it. (Every old name
  # aside first left an install with no scripts at all until the end.)
  while IFS= read -r f; do
    [ -n "$f" ] && [ -e "$NEW/$f" ] || continue
    ! not_ours "$f" || continue
    # One already here goes aside, whether the old release listed it or not:
    # moved onto, a folder takes the new one inside itself (HB-0071). Aside
    # before it is written down: written first, a cut in between left the
    # old one here under a name the rollback removes (HB-0279).
    if [ -e "$DIR/$f" ]; then mv "$DIR/$f" "$PREV/" || { echo "Could not move $DIR/$f aside."; exit 3; }; fi
    printf 'in %s\n' "$f" >> "$SWAPPING"
    mv "$NEW/$f" "$DIR/" || { echo "Could not move the new $f into $DIR."; exit 3; }
  done < <(grep -x scripts "$NEW/.bundle-files" || true; grep -vx scripts "$NEW/.bundle-files" || true)
  # What the old release had and this one does not.
  while IFS= read -r f; do
    [ -n "$f" ] && [ -e "$DIR/$f" ] || continue
    ! not_ours "$f" || continue
    ! grep -qxF "in $f" "$SWAPPING" || continue
    mv "$DIR/$f" "$PREV/" || { echo "Could not move $DIR/$f aside."; exit 3; }
  done <<< "$OLDLIST"
  RESTARTED=1; echo restarted >> "$SWAPPING"
  PATH="$DIR/.node/bin:$PATH" "$DIR/scripts/restart.sh" || { CHANGING=0; ROLLED_BACK=1; rollback_bundle || true; exit 1; }
  CHANGING=0; SERVING=1
  rm -f "$SWAPPING"
  echo "Now on $TARGET."
  rm -rf "$PREV"
else
# `npm ci` deletes node_modules before installing, so a registry outage or a
# full disk used to leave the machine with NO dependencies (and the rollback's
# own npm ci failing under the same fault). Keep the working tree aside until
# the new one is in.
# Only once the working one was moved aside (ASIDE): stopped while a stale
# node_modules.prev was being removed, the rollback deleted the only working
# node_modules (HB-0266).
restore_deps() {
  if [ -d node_modules.prev ]; then rm -rf node_modules; mv node_modules.prev node_modules
  elif [ "$ASIDE" = 1 ]; then rm -rf node_modules; fi
  return 0
}
# The service is restarted only if it was restarted onto the new release: an
# install that failed left the old one running, and restarting it anyway
# restarted production every ten minutes while a release that cannot install
# kept failing (review, 2026-10-09).
# A checkout cut off part-way (a signal to the whole unit) leaves HEAD and
# the index on CUR with files rewritten, and a plain checkout of CUR kept
# them: mixed code, refused as local changes by every later upgrade (HB-0266).
# Then the new release first, and back, forced: tracked files only (the
# upgrade started from a clean tree), so .env and data/ stay.
back_to_cur() {
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse "$TARGET^{commit}")" ] && [ -n "$(git status --porcelain)" ]; then
    git checkout --quiet --force "$TARGET" || return 1
  fi
  git checkout --quiet --force "$CUR"
}
rollback() {
  echo "Rolling back to ${CUR}…"
  back_to_cur && restore_deps || return 1
  if [ "$RESTARTED" = 1 ]; then $RESTART; fi
}
undo() { rollback && rm -f "$FROM_FILE"; }
# An upgrade killed (or a power cut) right after moving node_modules aside
# left node_modules.prev as the only working copy. Put back first: deleted as
# a leftover, a failed install then had nothing to roll back to (audit #033).
[ -d node_modules ] || [ ! -d node_modules.prev ] || mv node_modules.prev node_modules
# A leftover, removed before the record is written: half removed under it,
# the next run's repair would move it in as the old release's.
rm -rf node_modules.prev
CHANGING=1
printf 'from %s\n' "$CUR" > "$FROM_FILE"
if [ -d node_modules ]; then mv node_modules node_modules.prev; fi; ASIDE=1
git checkout --quiet "$TARGET"
# Exit 3: the install step failed (usually transient) and the old release is back untouched.
$INSTALL || { CHANGING=0; { rollback && rm -f "$FROM_FILE"; } || true; exit 3; }
RESTARTED=1; echo restarted >> "$FROM_FILE"
$RESTART || { CHANGING=0; ROLLED_BACK=1; { rollback && rm -f "$FROM_FILE"; } || true; exit 1; }
CHANGING=0; SERVING=1
# The record first: left behind beside a half-removed node_modules.prev, the
# next run moved that in over the release now serving.
rm -f "$FROM_FILE"; echo "Now on $TARGET."; rm -rf node_modules.prev || true
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
