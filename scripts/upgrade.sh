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
# changes, no such channel or release, its helpers not found); 3 did not
# complete (no network, an install that failed) with the previous release
# back as it was — try again;
# 4 another upgrade is running; 5 this machine had no room (a full disk) or no
# permission to write what the upgrade needs, with the previous release back
# as it was — try again, but it says nothing about the release (HB-0470);
# 6 the release put back by an earlier run is not up (its restart back did not
# come up, or was given up after three) and there was nothing more to do: no
# release was tried, and its record stays (kept_check, HB-1456);
# 7 the repair of an upgrade cut off part-way failed before the release was
# touched (a git lock in the way, the release put back not checked out, the
# dependencies' lock held for half an hour): it says nothing about the
# release, and the channel timer gives the repair a clock of its own
# (HB-1431). 7 only when the caller set HATCHABOT_FOLLOW_KNOWS_7=1
# (follow-channel.sh does); to any other it is 3.
set -euo pipefail
# Each cd with CDPATH empty: an exported one made cd print the folder it
# found, and $(cd …; pwd) said two lines.
[ -x "$(dirname "$0")/../.node/bin/node" ] && PATH="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/.node/bin:$PATH" && export PATH  # a bundle install's own Node (install.sh)
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)" || HERE=""   # this file's folder, before the cd: a relative $0 names it from here only
CDPATH= cd -- "$(dirname -- "$0")/.."
DIR="$PWD"

# Checking out a release replaces this file while bash is still reading it.
# The helpers it shares with deploy-release.sh (scripts/upgrade-helpers.sh)
# go in that copy, ahead of it, and only the file this one was made with:
# HELPERS_BLOB is its git blob id (test/upgradeHelpers.test.ts holds it to
# that file). From this install's git when it has it: an upgrade cut off in
# its checkout can leave scripts/ part one release and part the other, and
# the file beside this one another release's. Else from beside it, once git
# says it is that file; with no git (a bundle install, whose scripts/ moves
# whole), as it is. Found nowhere, this stops with nothing changed (2).
# Read from it: machine_short, free_mb, disk_words, said_kind, said_path,
# own_place, disk_short, step_tee, step_tail, new_step_log, run_step,
# step_short, put_rec, change_failed (a failed step's words); link_end,
# put_line, put_dir, put_failed (the records); proc_start, proc_start_utc,
# started_as, lock_left_over, take_lock, lock_short, lock_in_way (the lock);
# deps_holder_gone, deps_take, deps_lock, deps_unlock, restore_deps;
# kept_tries, kept_record; checkout_recorded; git_running_here,
# clear_own_index_lock, save_other_edits, repair_tree (a run cut off
# part-way); older_release,
# mark_rolled_back, systemd_major, env_named, rolled_back_note, left_ran,
# unmark_rolled_back (the rollback's note); service_port (the listener's
# port).
HELPERS_BLOB=9d164eaedd24f2f19485c1ade1813db80b790f95
if [ -z "${HATCHABOT_UPGRADE_COPY:-}" ]; then
  # This file by its own folder: "$0" names it from where it was started, and
  # the cd above moved from there (a relative one not from the install, as
  # `bash upgrade.sh` in scripts/, read as a full disk, 5).
  self=""; [ -z "$HERE" ] || self="$HERE/${0##*/}"
  [ -n "$self" ] && [ -f "$self" ] || { echo "Could not find this script ($0) to run it from a temporary copy, so nothing was changed. Run it by its path, scripts/upgrade.sh in the install, then try again."; exit 2; }
  NO_HELPERS="This upgrade.sh needs scripts/upgrade-helpers.sh as its own release has it, and found it neither in $DIR's git nor beside it, so nothing was changed. Put this release's scripts/ folder back whole, then try again."
  from=""
  if [ -e .git ] && git --no-replace-objects cat-file -e "$HELPERS_BLOB" 2>/dev/null; then from=git
  elif [ -n "$HERE" ] && [ -f "$HERE/upgrade-helpers.sh" ]; then from="$HERE/upgrade-helpers.sh"; fi
  [ -n "$from" ] || { echo "$NO_HELPERS"; exit 2; }
  # The copy is removed however this ends but by its exec (and by an exec that
  # failed: execfail, so set -e ends it here, through the trap).
  tmp=""; trap 'rm -f "$tmp"' EXIT
  # Its own message and exit 5: under set -e a full temp folder ended this with
  # exit 1, which the channel timer reads as "this release is bad" (HB-0438),
  # and with 3 a disk that stayed full set the release aside (HB-0470).
  COPY_SHORT="Could not make a temporary copy of this script (a full disk?): nothing was changed. Free some space, then try again."
  tmp="$(mktemp)" && if [ "$from" = git ]; then git --no-replace-objects cat-file blob "$HELPERS_BLOB" > "$tmp"; else cat "$from" > "$tmp"; fi || { echo "$COPY_SHORT"; exit 5; }
  # The bytes read are judged, not the file before them: with git, they are
  # the file this was made with, or nothing goes on.
  if [ -e .git ] && [ "$(git hash-object --stdin < "$tmp" 2>/dev/null)" != "$HELPERS_BLOB" ]; then echo "$NO_HELPERS"; exit 2; fi
  { echo; cat "$self"; } >> "$tmp" || { echo "$COPY_SHORT"; exit 5; }
  shopt -s execfail
  HATCHABOT_UPGRADE_COPY="$tmp" HATCHABOT_UPGRADE_DIR="$DIR" exec bash "$tmp" "$@"
fi
DIR="$HATCHABOT_UPGRADE_DIR"; cd "$DIR"
# The copy has them all, or it was not made by the lines above.
declare -F upgrade_helpers_end >/dev/null || { echo "This run of upgrade.sh has not got the helpers it needs (scripts/upgrade-helpers.sh), so nothing was changed. Run scripts/upgrade.sh itself, with no HATCHABOT_UPGRADE_COPY set."; exit 2; }

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
DEPS_HELD=0     # 1 while this run holds the dependencies' lock (deps_lock)
SERVING=0       # 1 once the new release is up: only tidying is left
DISK=0          # 1 once this run found the machine short of room or permission (machine_short)
KEPT=0          # 1 once this run ends on a release put back that is not up (stop_or_go)
KEPT_REC=""     # that release's record, which this run's own upgrade takes the place of (stop_or_go)
REPAIR_FAILED=0 # 1 once this run's repair of an upgrade cut off failed, before the release was touched (repair_failed)
BACK_DOWN=0     # 1 once a rollback's restart back did not come up (back_down said what comes next)
LOCK=""; STAGE=""; STAGE_FREED=0; STEP_LOG=""; STEP_SAID=""
PIN_ON=""       # the pin this run answers for, its own or one a killed run left; PRE_*: what it replaced
PIN_RECORD=""; PRE_CHANNEL=""; PRE_USER_CHANNEL=""
undo() { :; }   # set below, per kind of install
REDO="hatchabot upgrade"   # what a person runs when the rollback did not work (change_failed)
RUN_NOUN=upgrade   # how the helpers name this run (clear_own_index_lock)
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
  # A pin on a release this run did not end up on would hold the machine at one
  # it is not running, with the timer quiet and the public address's safeguard off
  # (HB-0428), so it goes back to what it replaced. Unless a channel was named since.
  if [ -n "$PIN_ON" ]; then
    if [ "$rc" != 0 ] && [ "$(remembered_channel)" = "$PIN_ON" ]; then unpin; fi
    rm -f "$PIN_RECORD" "$PIN_RECORD.tmp"
  fi
  [ "$DEPS_HELD" != 1 ] || deps_unlock
  # Only its holder lets it go: a lock cleared and taken by another run is theirs.
  [ -z "$LOCK" ] || [ "$(cat "$LOCK/owner" 2>/dev/null)" != "$ME" ] || rm -rf "$LOCK"
  rm -f "$HATCHABOT_UPGRADE_COPY"; [ -z "$STAGE" ] || rm -rf "$STAGE"; [ -z "$STEP_LOG" ] || rm -f "$STEP_LOG"
  # 5 only where this run found the disk or a permission (machine_short): under
  # set -e a command that exits 5 for its own reasons (curl 5, a node fatal
  # error) read as "the disk", which the timer retries for ever (review of HB-0470).
  case "$rc" in
    0|2|3|4) ;;
    5) [ "$DISK" = 1 ] || rc=3 ;;
    6) [ "$KEPT" = 1 ] || rc=3 ;;
    7) [ "$REPAIR_FAILED" = 1 ] && [ "${HATCHABOT_FOLLOW_KNOWS_7:-}" = 1 ] || rc=3 ;;
    1) [ "$ROLLED_BACK" = 1 ] || rc=3 ;;
    *) rc=3 ;;
  esac
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
file_channel() { if [ -f "$1" ]; then tr -d '[:space:]' < "$1"; fi; }
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
NOTED=0   # 1 once this run wrote the rollback's note for an older release (mark_rolled_back)
PUT_PATH=""; PUT_ERR=""   # what put_line and put_dir say

# A channel asked for by name is remembered, so the next plain upgrade follows it
# — even when there is nothing to install today. Not when the channel timer
# asks (follow-channel.sh): it named its own channel, and writing that undid a
# `hatchabot upgrade beta` within ten minutes (review, 2026-10-09).
# remember_channel VALUE [RELEASE]: VALUE for this install. RELEASE, the one
# it will run, from before v2.169.0 reads only the user's file: it goes there
# (and this install's own goes, so the two cannot disagree once it is back).
# Each step only once the one before it worked, and non-zero if any failed:
# called under `||`, set -e is off in here, and a failed write of the user's
# file was passed over, this install's own deleted, and the pin said made
# (second review of HB-0470).
remember_channel() {
  if [ -n "${2:-}" ] && [ "$(vernewer "$2" "$PER_INSTALL_FROM")" != "$2" ]; then
    put_line "$USER_CHANNEL_FILE" "$1" && rm -f "$CHANNEL_FILE"
  else
    put_line "$CHANNEL_FILE" "$1"
  fi
}
if [ "${HATCHABOT_UPGRADE_BY_TIMER:-}" != 1 ]; then
case "$ARG" in
  stable|beta|latest) PRC=0; remember_channel "$ARG" || PRC=$?; [ "$PRC" = 0 ] || put_failed "$PRC" "Could not write which channel this machine follows (a full disk, or no permission?), so nothing was changed. Free some space, then try again." ;;
esac
fi
# A version named by hand is a pin: the channel timer leaves this machine
# alone until a channel is named again (a rollback used to be undone within
# ten minutes; use-case audit, 2026-09-27). Written once that release is known
# to be there, under the lock (below), not here: a mistyped version, a dirty
# tree or a busy lock left a pin on a release never installed, with the timer
# quiet for good and the public address's safeguard off (HB-0428).
# What it replaces is written down first, beside the lock (PIN_RECORD): SIGKILL
# or a power cut runs no finish, and the next run, the timer's as a rule, has to
# know where to go back to if this release does not end up installed. A run that
# took over a killed run's pin (below) goes back to what that pin replaced.
pin_named() {
  [ "${HATCHABOT_UPGRADE_BY_TIMER:-}" != 1 ] || return 0
  case "$ARG" in
    v[0-9]*) ;;
    *) return 0 ;;
  esac
  if [ -z "$PIN_ON" ]; then
    PRE_CHANNEL="$(file_channel "$CHANNEL_FILE")"; PRE_USER_CHANNEL="$(file_channel "$USER_CHANNEL_FILE")"
  fi
  # This machine's disk, not the release's: exit 5 (review of HB-0470); something
  # in the way of the record, named (2); else 3 (put_failed).
  local prc=0
  put_line "$PIN_RECORD" "pin $ARG" "channel $PRE_CHANNEL" "user $PRE_USER_CHANNEL" || prc=$?
  [ "$prc" = 0 ] || put_failed "$prc" "Could not write $PIN_RECORD (a full disk, or no permission there?), so nothing was changed. Free some space, then try again."
  PIN_ON="$ARG"
  remember_channel "$ARG" "$ARG" || prc=$?
  [ "$prc" = 0 ] || put_failed "$prc" "Could not write which release this machine is pinned to (a full disk, or no permission?), so nothing was changed. Free some space, then try again."
  echo "Pinned to $ARG — automatic upgrades pause here. Follow a channel again with: hatchabot upgrade stable"
}
unpin() {
  local f v
  for f in CHANNEL_FILE USER_CHANNEL_FILE; do
    if [ "$f" = CHANNEL_FILE ]; then v="$PRE_CHANNEL"; else v="$PRE_USER_CHANNEL"; fi
    if [ -n "$v" ]; then put_line "${!f}" "$v" || echo "Could not put ${!f} back to $v (${PUT_ERR:-$PUT_PATH is in the way}): it may still name $PIN_ON."; else rm -f "${!f}"; fi
  done
  echo "Not pinned to $PIN_ON: the upgrade did not finish, so this machine goes on as it was."
}

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
LOCKS="${XDG_STATE_HOME:-$HOME/.local/state}/hatchabot"
PRC=0; put_dir "$LOCKS" || PRC=$?
[ "$PRC" = 0 ] || put_failed "$PRC" "Could not make $LOCKS, where upgrades keep their lock (a full disk, or no permission there?): nothing was changed. Free some space or fix its permissions, then try again."
LOCK_PATH="$LOCKS/upgrade-$(printf %s "$DIR" | cksum | cut -d' ' -f1).lock.d"
ME="$$"; MY_START="$(proc_start $$)"; [ -z "$MY_START" ] || ME="$$ $MY_START"
ME_UTC="$$ $(proc_start_utc $$)"
# release-target.sh: 1 = no such channel or release (it says which), anything
# else = it could not find out (no network, an answer that is not a channels
# file). Neither is the release failing: `|| exit 1` here once got releases
# that were never tried blacklisted by the channel timer (review, 2026-10-09).
# The channel timer (follow-channel.sh) resolved the channel already and
# remembers a failure by that release: it passes it, so the release tried is
# the one it records (audit #042).
# HATCHABOT_UPGRADE_REPAIR_ONLY=1: the channel timer could not find the release
# (no network), but an upgrade cut off part-way is here to repair. That needs
# nothing from the network, so it is done, and nothing else (HB-0547).
# Looked for before the lock, a lookup that failed may be the tree changing
# under an upgrade that holds it (a bundle swap moves scripts/): that is 4, as
# taking the lock first said.
REPAIR_ONLY=0; [ "${HATCHABOT_UPGRADE_REPAIR_ONLY:-}" != 1 ] || REPAIR_ONLY=1
TARGET=""; LOOKED=0
find_target() {
  local trc=0
  if [ "$REPAIR_ONLY" = 1 ]; then
    TARGET=""
  elif [ -n "${HATCHABOT_UPGRADE_TARGET:-}" ]; then
    case "$HATCHABOT_UPGRADE_TARGET" in
      v[0-9]*) TARGET="$HATCHABOT_UPGRADE_TARGET" ;;
      *) echo "Not a release: $HATCHABOT_UPGRADE_TARGET"; exit 2 ;;
    esac
  else
    TARGET="$("$DIR/scripts/release-target.sh" "$CHANNEL")" || trc=$?
    [ "$trc" != 1 ] || exit 2
    if [ "$trc" != 0 ]; then
      if [ -z "$LOCK" ] && [ -d "$LOCK_PATH" ] && ! lock_left_over; then echo "Another upgrade of $DIR is running (lock $LOCK_PATH)."; exit 4; fi
      echo "Could not find which release $CHANNEL names now — try again later."; exit 3
    fi
  fi
  [ "$REPAIR_ONLY" = 1 ] || [ -n "$TARGET" ] || { echo "Could not find which release $CHANNEL names (no network to github.com?)."; exit 3; }
  LOOKED=1
}
# Before the lock, unless scripts/ is not here to look with: a rollback cut
# between its renames (below) is repaired first, under the lock.
if [ -e "$DIR/scripts/release-target.sh" ] || [ "$REPAIR_ONLY" = 1 ] || [ -n "${HATCHABOT_UPGRADE_TARGET:-}" ]; then find_target; fi

LOCK_RC=0; take_lock || LOCK_RC=$?
[ "$LOCK_RC" != 2 ] || lock_short
if [ "$LOCK_RC" != 0 ]; then
  # Clearing takes milliseconds: a clearing lock this old is a crash's.
  [ -z "$(find "$LOCK_PATH.clearing" -maxdepth 0 -mmin +10 2>/dev/null)" ] || rmdir "$LOCK_PATH.clearing" 2>/dev/null || true
  if [ -d "$LOCK_PATH" ] && lock_left_over && mkdir "$LOCK_PATH.clearing" 2>/dev/null; then
    if lock_left_over; then rm -rf "$LOCK_PATH"; fi
    rmdir "$LOCK_PATH.clearing" 2>/dev/null || true
  fi
  LOCK_RC=0; take_lock || LOCK_RC=$?
  [ "$LOCK_RC" != 2 ] || lock_short
  lock_in_way
  [ "$LOCK_RC" = 0 ] || { echo "Another upgrade of $DIR is running (lock $LOCK_PATH)."; exit 4; }
fi

# A rollback cut between its last two renames of scripts/ (restore_prev,
# below) left none here, and the old one beside it: in it goes, under the lock
# (a held lock leaves it to its holder) and before anything reads scripts/.
# No timer can run then; the new release's upgrade.sh, held in
# .rollback-aside, run by hand repairs it (fourth and fifth reviews of HB-0487).
if [ "$BUNDLED" = 1 ] && [ ! -e scripts ] && [ ! -L scripts ] && [ -d .rollback-scripts ] && [ ! -L .rollback-scripts ]; then
  mv .rollback-scripts scripts || { echo "Could not move $DIR/.rollback-scripts back to scripts/ (above)."; exit 3; }
fi

# Which release CHANNEL names was looked for before the lock (above): with
# the network down the lookup can take minutes, and it held the lock all that
# while, so a channel tick then said "another upgrade" (4) and did nothing
# (tenth review). Here only when scripts/ had to be put back first.
if [ "$LOOKED" = 0 ]; then find_target; fi

# A bundle swap moves the old release's files into .prev-release, then the
# new one's in, one by one. Cut off part-way (SIGKILL, a power cut), it left
# the tree half old, half new; BUNDLE.json was often the new one already, so
# every later run said "Already on vNEW" and the install stayed broken
# (HB-0049). The swap writes .swapping before its first move, and names each
# file in it before moving that file in: the next run puts the previous
# release back first, then upgrades as usual.
SWAPPING="$DIR/.swapping"; PREV="$DIR/.prev-release"
FROM_FILE="${LOCK_PATH%.lock.d}.from"   # a git install's, described below
# A pin a killed run left: `pin <release>`, `channel <what data/channel held>`,
# `user <what the user's file held>`. This run now sees it through, and if that
# release does not end up installed, finish puts those back (HB-0428): until then
# the machine is held at a release it does not run, and the timer would have
# nothing more to do. A channel named since, or a kill before the pin was written:
# the record no longer means anything. An upgrade.sh from before the record left
# only the pin and the swap to repair, so what the pin replaced is not known: it
# comes off, which leaves the other file, then the timer's own channel.
# Only that one: every upgrade.sh that writes the record says so in the swap's or
# the checkout's own record (PINS_RECORDED), and writes the pin's record first. A
# version with no pin record beside one of those is the person's own: a pin
# completed earlier, or one a failed repair just put back while that repair is
# still owed. Read as a leftover, the next failed repair deleted it (HB-0428).
PIN_RECORD="${LOCK_PATH%.lock.d}.pin"; PINS_RECORDED="pins-recorded"
CUT_RECORD="$FROM_FILE"; [ "$BUNDLED" = 0 ] || CUT_RECORD="$SWAPPING"
if [ -f "$PIN_RECORD" ]; then
  LEFT_PIN="$(sed -n 's/^pin //p' "$PIN_RECORD" | sed -n 1p)"
  if [ -n "$LEFT_PIN" ] && [ "$(remembered_channel)" = "$LEFT_PIN" ]; then
    PRE_CHANNEL="$(sed -n 's/^channel //p' "$PIN_RECORD" | sed -n 1p)"
    PRE_USER_CHANNEL="$(sed -n 's/^user //p' "$PIN_RECORD" | sed -n 1p)"
    PIN_ON="$LEFT_PIN"
  else
    rm -f "$PIN_RECORD"
  fi
elif [ -f "$CUT_RECORD" ] && ! grep -qx "$PINS_RECORDED" "$CUT_RECORD"; then
  LEFT_PIN="$(remembered_channel)"
  case "$LEFT_PIN" in
    v[0-9]*)
      PRE_CHANNEL="$(file_channel "$CHANNEL_FILE")"; [ "$PRE_CHANNEL" != "$LEFT_PIN" ] || PRE_CHANNEL=""
      PRE_USER_CHANNEL="$(file_channel "$USER_CHANNEL_FILE")"; [ "$PRE_USER_CHANNEL" != "$LEFT_PIN" ] || PRE_USER_CHANNEL=""
      PIN_ON="$LEFT_PIN" ;;
  esac
fi
# A name a bundle's file list may not touch: a path, or what is this machine's.
not_ours() {
  case "$1" in
    ''|*/*|.|..|.env|data|.swapping|.swapping.tmp|.prev-release|.rollback-aside|.rollback-scripts) return 0 ;;
  esac
  return 1
}
# Back to the release in .prev-release: the previous files moved back, then
# what else came in from the new bundle removed. Run again after a cut, it
# goes on: each file's `in` line is struck from .swapping before it moves
# back, so one already back is the old release's, never removed as the new
# one's. It was, and a rollback cut off after putting a file back deleted it
# for good (HB-0279). Struck, not marked: an upgrade.sh from before this
# reads only `in` lines, and scripts/ goes back first (cut off, the tree
# holds an upgrade.sh that goes on), so the old one may finish the job.
restore_prev() {
  # held: the new release's copy of a name, kept until the old one is in.
  local line f n src aside held="$DIR/.rollback-aside" beside="$DIR/.rollback-scripts" back='
' unstruck=0
  # Every move here goes onto a name that is not there: mv onto a folder puts
  # what moves inside it (HB-0071), and `mv -T`, which would refuse, is GNU's
  # alone. A held copy a failed rm left took the next name inside itself, and a
  # put-back nested scripts/scripts/ (review of HB-0487).
  gone() { [ ! -e "$1" ] && [ ! -L "$1" ]; }
  # The old scripts/ goes in through a name beside it (below). A cut with it
  # there: with no scripts/ here, it was cut between the last two renames, and
  # it goes in; else it goes back to .prev-release, and is put in again.
  if ! gone "$beside"; then
    if gone "$DIR/scripts"; then mv "$beside" "$DIR/scripts" || return 1
    elif gone "$PREV/scripts"; then mkdir -p "$PREV" && mv "$beside" "$PREV/scripts" || return 1
    else echo "$beside and $PREV/scripts are both there: which is the previous release's cannot be told. Remove the one that is not, then try again."; return 1
    fi
  fi
  rm -rf "$held"
  gone "$held" || { echo "Could not remove $held (above)."; return 1; }
  for f in "$PREV"/scripts "$PREV"/* "$PREV"/.[!.]*; do
    [ -e "$f" ] || continue
    n="${f##*/}"
    src="$f"
    # scripts/ is what the timer and the repair run: with a cut between moving
    # the new one aside and the old one in, there was none, and nothing could
    # put the release back. The old one is put beside it first, struck, and
    # then the two renames run back to back: the only moment with no scripts/
    # is between those two (no rename swaps two folders), and a cut anywhere
    # else is gone on from above (fourth review of HB-0487).
    if [ "$n" = scripts ] && ! gone "$DIR/scripts"; then
      mv "$f" "$beside" || return 1
      src="$beside"
    fi
    # One of that name here, the new one, would take the old one inside
    # itself, a directory in a directory (HB-0071). It goes aside, not away,
    # until the old one is in: removed first, a move that failed left the
    # install with no scripts/, so no upgrade.sh to repair it (HB-0487).
    # Struck before the old one goes in: struck after, a cut in between left
    # the old one listed as the new one's, for the old upgrade.sh to remove.
    aside=0
    if [ "$src" = "$f" ] && ! gone "$DIR/$n"; then
      mv "$DIR/$n" "$held" || return 1
      aside=1
    fi
    # A record that cannot be rewritten (the disk that filled) does not stop
    # the rollback: the moves are what count, and this run remembers what it
    # put back (twelfth review). It ended "did not work either", 3, with the
    # old release one rename from back.
    if [ -f "$SWAPPING" ] && grep -qxF "in $n" "$SWAPPING"; then
      { { grep -vxF "in $n" "$SWAPPING" || [ $? = 1 ]; } > "$SWAPPING.tmp" && mv -f "$SWAPPING.tmp" "$SWAPPING"; } 2>/dev/null || {
        rm -f "$SWAPPING.tmp" 2>/dev/null || true
        unstruck=1
      }
    fi
    if [ "$src" != "$f" ]; then
      mv "$DIR/$n" "$held" || { mv "$beside" "$f"; return 1; }
      aside=1
    fi
    if ! gone "$DIR/$n" || ! mv "$src" "$DIR/$n"; then
      [ "$aside" = 0 ] || ! gone "$DIR/$n" || mv "$held" "$DIR/$n"
      [ "$src" = "$f" ] || gone "$beside" || mv "$beside" "$f"
      return 1
    fi
    back="$back$n
"
    rm -rf "$held"
    gone "$held" || { echo "Could not remove $held (above)."; return 1; }
  done
  [ "$unstruck" = 0 ] || echo "Could not write $SWAPPING as the files went back (a full disk?): they are back all the same."
  # The new release's unpacked bundle, beside the install.
  STAGED="$(sed -n 's/^stage //p' "$SWAPPING" 2>/dev/null | sed -n 1p)"
  case "$STAGED" in
    "$(dirname "$DIR")"/.hatchabot-next-*) ;;
    *) STAGED="" ;;
  esac
  if [ -f "$SWAPPING" ]; then
    while IFS= read -r line; do
      case "$line" in
        "in "?*) f="${line#in }" ;;
        *) continue ;;
      esac
      # Put back just now, its line not struck: the old one's, kept.
      case "$back" in
        *"
$f
"*) continue ;;
      esac
      # The unpacked bundle gone, and not by this run: only a rollback of this
      # upgrade.sh's frees it first, and this one was cut off once it had put
      # files back whose lines it could not strike (a full disk). The one here
      # may be the old one put back: kept. Removed, the install lost a file of
      # the release it went back to (fourteenth review). One the new release
      # alone had is kept too, a leftover the next swap moves aside; the
      # record goes below, whole, so nothing is struck here.
      if [ -n "$STAGED" ] && [ "$STAGE_FREED" = 0 ] && [ ! -e "$STAGED" ] && [ ! -L "$STAGED" ]; then continue; fi
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
  # With a restart back to follow (restore_prev RELEASE), the record becomes
  # that restart's (put_back_rec), in one move: removed and written after, a
  # cut in between left the release put back with no record, and nothing
  # restarted it (review of HB-1456). Not written, it goes as before.
  if [ "$#" -gt 0 ] && put_back_rec "$1"; then rm -f "$SWAPPING.tmp"
  else rm -f "$SWAPPING" "$SWAPPING.tmp"; fi
}

# The dependencies' own lock, ensure-deps.sh's (its DEPS_LOCK: the same
# folder, name and holder line, a pid and its start in UTC), held while
# node_modules is moved aside or put back: a git install's, and a bundle's in
# its swap (the bundle's own node_modules among its files). Moved without
# it, a restart's npm ci running there meanwhile had its tree moved from
# under it, and the stamp it wrote then said up to date over a partial tree
# (HB-1212). deps_lock and deps_unlock, scripts/upgrade-helpers.sh's, as
# deploy-release.sh's.
# Held for the move alone: the install step runs ensure-deps.sh, which takes
# it itself. Written out here, not asked of ensure-deps.sh: a repair moves the
# dependencies back under a release whose ensure-deps.sh may be older than
# this script. Waited for as ensure-deps.sh waits for it, half an hour at
# most (then deps_lock returns 1); with no lock to be had at all (no room, no
# permission) the move goes on without it, as an install does. Keyed on the
# folder's physical path, as ensure-deps.sh's: reached through a symlink, a
# restart and an upgrade took two locks (HB-1377).
DEPS_LOCK="$LOCKS/deps-$(printf %s "$(pwd -P)" | cksum | cut -d' ' -f1).lock.d"
# And, reached through a link, the one the scripts of releases before 2.193.0
# key on the path as given, taken after it (deps_lock; review of HB-1377).
DEPS_LOCK_OLD="$LOCKS/deps-$(printf %s "$DIR" | cksum | cut -d' ' -f1).lock.d"
[ "$DEPS_LOCK_OLD" != "$DEPS_LOCK" ] || DEPS_LOCK_OLD=""
DEPS_ME="$$"; DEPS_START="$(proc_start_utc $$)"; [ -z "$DEPS_START" ] || DEPS_ME="$$ $DEPS_START"
# How many one-second tries the lock is waited for: half an hour (tests make it a few).
DEPS_WAIT="${HATCHABOT_DEPS_WAIT_SECS:-1800}"
case "$DEPS_WAIT" in
  ''|*[!0-9]*) DEPS_WAIT=1800 ;;
esac
DEPS_STUCK="Another install of the dependencies in $DIR has held $DEPS_LOCK for half an hour, so nothing was moved. If no npm is running there, remove it (rm -r \"$DEPS_LOCK\"), then try again."

# A restart back that did not come up keeps its record (HB-1456): the next
# run asks first whether the release put back is serving now (kept_check),
# as a slow one came up after the wait and was restarted every run all the
# same; not serving, it is restarted again, KEPT_MAX times in all (the
# record's `tries` lines, back_down), then left for a person, said each run.
# A run going on to another release goes on (stop_or_go): the record kept
# stopped every upgrade, and the newer release, which may come up where this
# one does not, was never tried. One with nothing more to do ends 6: no
# release was tried, so the timers count no try, and a pin stays (finish).
# (review of HB-1456)
KEPT_MAX=3
# Counted are tries: restart.sh may fail before it restarts anything (ensure-deps).
kept_stop() { echo "$1 is back in $DIR, but it has not come up after $3 tries to restart it, so upgrades stop restarting it (a rollback to it from another release still does). Once what stops it is fixed (hatchabot doctor), remove the record and restart it: rm \"$2\"; $DIR/scripts/restart.sh"; }
# back_down RELEASE RECORD: a restart back onto RELEASE did not come up: counted, and said.
back_down() {
  local n
  n=$(( $(kept_tries "$2") + 1 ))
  printf 'tries %s\n' "$n" >> "$2" 2>/dev/null || true
  if [ "$n" -lt "$KEPT_MAX" ]; then echo "$1 is back in $DIR, but it did not come up (above). $2 stays: the next upgrade restarts it again if it is still not serving ($n of $KEPT_MAX)."
  else kept_stop "$1" "$2" "$n"; fi
}
# kept_check RELEASE RECORD RESTART…: 0 when RELEASE serves now (the record
# goes, and nothing is restarted), 2 when it was restarted KEPT_MAX times
# already, 1 to restart it again. Asked once, of restart.sh's own health check
# (HATCHABOT_RESTART_PROBE), and only once the service manager has restarted
# it onto RELEASE (`back`): before, what answers may be the release left,
# still running.
kept_check() {
  local rel="$1" rec="$2" n
  shift 2
  if grep -qx back "$rec" 2>/dev/null && HATCHABOT_RESTART_PROBE=1 "$@" >/dev/null 2>&1; then echo "$rel is back in $DIR and serving now, so $rec is removed."; rm -f "$rec"; return 0; fi
  n="$(kept_tries "$rec")"
  [ "$n" -lt "$KEPT_MAX" ] || { kept_stop "$rel" "$rec" "$n"; return 2; }
  return 1
}
# stop_or_go RELEASE RECORD: RELEASE, put back, is not up. A run going on to
# another release goes on, and its own record takes the place of RECORD
# (went_on says so once it has; kept_again, if it goes back before restarting
# anything); else 6 (kept_end).
stop_or_go() {
  if [ "$REPAIR_ONLY" = 0 ] && [ -n "$TARGET" ] && [ "$TARGET" != "$1" ]; then
    KEPT_REC="$2"; KEPT_FROM="${1:-the release put back}"; KEPT_SAVED="$(cat "$2" 2>/dev/null || true)"
    return 0
  fi
  kept_end named
}
# kept_end [named]: 6, any pin and its record left for the next run (finish).
# But the release put back named by hand (`named`: by its own name, or by
# another, "Already on") is the one asked for, and in the tree: pinned, as
# "Already on" pins it, though it is not up. Left unpinned, the next tick of
# the timer moved the machine to its channel's release (review of HB-1456).
kept_end() {
  if [ "${1:-}" = named ]; then
    case "${HATCHABOT_UPGRADE_BY_TIMER:-}:$ARG" in
      1:*) ;;
      *:v[0-9]*) pin_named; rm -f "$PIN_RECORD" ;;
    esac
  fi
  PIN_ON=""; KEPT=1; exit 6
}
# went_on: said once this run's own record has taken the place of the one
# kept (stop_or_go). Said there, the run could still end (6, 2, 3 or 4) with
# that record as it was, and the words untrue.
went_on() { [ -z "$KEPT_REC" ] || echo "Going on to $TARGET, which may come up where $KEPT_FROM does not: this upgrade's own record has taken the place of $KEPT_REC."; }
# kept_again: this run went back to the release put back without restarting
# anything, so it is still not up, and its record goes back as it was when
# this run went on (with this run's tries).
kept_again() {
  put_line "$KEPT_REC" "$KEPT_SAVED" || { echo "Could not write $KEPT_REC again (${PUT_ERR:-$PUT_PATH is in the way}), so nothing restarts $KEPT_FROM: once that is fixed, run $DIR/scripts/restart.sh"; return 0; }
  echo "$KEPT_REC stays for the next run: $KEPT_FROM is still not up."
}
# put_back_rec RELEASE: .swapping as the record of a bundle's restart back onto
# RELEASE, its files back. It names no file to move (no `in`, no `stage`), so
# the next run's restore_prev, an older release's too, moves nothing; restart.sh
# adds `back` once the service manager has restarted it, so that run writes no
# note (left_ran); `pins-recorded`, so a pin is not read as one an upgrade.sh
# from before the pin's record left; `put-back`, for what that run does.
put_back_rec() { put_line "$SWAPPING" "from $1" "$PINS_RECORDED" says-started restarted put-back; }
# restart_back RELEASE: a bundle's restart back onto RELEASE, with its record
# (put_back_rec): removed once it comes up, kept (back_down) when it does not
# (restart.sh's health wait). With none, a release put back that did not come
# up was left down, and nothing tried again (HB-1456). 1 when it did not come up.
restart_back() {
  local rec=1
  [ -f "$SWAPPING" ] || rec=0
  if HATCHABOT_RESTART_BACK=1 HATCHABOT_RESTART_RECORD="$SWAPPING" PATH="$DIR/.node/bin:$PATH" "$DIR/scripts/restart.sh"; then
    rm -f "$SWAPPING"
    return 0
  fi
  if [ "$rec" = 1 ]; then back_down "$1" "$SWAPPING"
  else echo "$1 is back in $DIR, but it did not come up (above), and $SWAPPING could not be written (a full disk, or something in its way), so nothing restarts it again: once that is fixed, run $DIR/scripts/restart.sh"; fi
  return 1
}
# repair_failed: a repair below stopped before the release was touched: 7 (to
# a timer that knows it, finish), which is no try of the release. Counted as
# one (3), a repair that kept failing set a good release aside (HB-1431).
repair_failed() { REPAIR_FAILED=1; exit 7; }
if [ "$BUNDLED" = 1 ] && [ -f "$SWAPPING" ]; then
  BACK_TO="$(sed -n 's/^from //p' "$SWAPPING" | sed -n 1p)"
  if grep -qx put-back "$SWAPPING"; then
    # Its files are back already: only its restart is owed (restart_back).
    echo "${BACK_TO:-The previous release} was put back in $DIR by an earlier run, whose restart of it did not come up or was cut off."
    KC=0; kept_check "${BACK_TO:-The previous release}" "$SWAPPING" env "PATH=$DIR/.node/bin:$PATH" "$DIR/scripts/restart.sh" || KC=$?
    if [ "$KC" = 1 ]; then restart_back "${BACK_TO:-The previous release}" || stop_or_go "$BACK_TO" "$SWAPPING"
    elif [ "$KC" = 2 ]; then stop_or_go "$BACK_TO" "$SWAPPING"; fi
  else
    echo "An upgrade of $DIR was cut off part-way — putting ${BACK_TO:-the previous release} back first."
    WAS_RESTARTED=0; ! grep -qx restarted "$SWAPPING" || WAS_RESTARTED=1
    # Read before restore_prev, which replaces the record (left_ran).
    LEFT_RAN=0; ! left_ran "$SWAPPING" || LEFT_RAN=1
    NOTED_AT="$(sed -n 's/^noted //p' "$SWAPPING" | tail -n 1)"
    STARTED=0; ! grep -qx started "$SWAPPING" || STARTED=1
    # Under the dependencies' lock, as every move of node_modules (deps_lock).
    deps_lock || { echo "Another install of the dependencies in $DIR has held $DEPS_LOCK for half an hour, so the previous release's files are still in $PREV, not put back: the next upgrade puts them back first. If no npm is running there, remove it: rm -r \"$DEPS_LOCK\""; repair_failed; }
    # The service was already restarted onto the new release: back onto this
    # one, written down only if the new release really ran and nothing went back since.
    # A note written for an older release named, which never started, goes as
    # that run's rollback would have taken it away (unmark_rolled_back, HB-1455);
    # one that started, the rollback saw to. Before the files go back: from
    # there the record is the restart back's alone (restore_prev RELEASE), so a
    # run cut off after it owes only the restart (review of HB-1456).
    RP=0
    if [ "$WAS_RESTARTED" = 1 ]; then
      if [ "$LEFT_RAN" = 1 ]; then mark_rolled_back "$DIR"; elif [ -n "$NOTED_AT" ] && [ "$STARTED" = 0 ]; then unmark_rolled_back "$DIR" "$NOTED_AT"; fi
      restore_prev "$BACK_TO" || RP=1
    else
      restore_prev || RP=1
    fi
    [ "$RP" = 0 ] || { echo "Could not put the previous release back (above): $PREV holds its files."; repair_failed; }
    deps_unlock
    [ "$WAS_RESTARTED" = 0 ] || restart_back "${BACK_TO:-The previous release}" || stop_or_go "$BACK_TO" "$SWAPPING"
  fi
fi

RESTART="${HATCHABOT_RESTART_CMD:-./scripts/restart.sh}"   # overridable for tests only
# A git install's upgrade in progress, beside the lock (in the tree it would
# read as a local change): `from <release>`, then `restarted` once the service
# was restarted onto the new one (and `started`, `back`: left_ran). Left behind, the run was killed part-way
# (SIGKILL, a power cut): the checkout may be on the new release with half
# its dependencies installed, and the old ones in node_modules.prev. The next
# run puts the old release back first, then upgrades as usual (HB-0043).
if [ "$BUNDLED" = 0 ] && [ -f "$FROM_FILE" ]; then
  FROM="$(sed -n 's/^from //p' "$FROM_FILE" | sed -n 1p)"; TO="$(sed -n 's/^to //p' "$FROM_FILE" | sed -n 1p)"
  if kept_record "$FROM_FILE"; then echo "${FROM:-The previous release} was put back in $DIR by an earlier run, whose restart of it did not come up or was cut off."
  else echo "An upgrade of $DIR was cut off part-way — putting ${FROM:-the previous release} back first."; fi
  clear_own_index_lock || repair_failed
  repair_tree || { echo "Could not check out ${FROM:-the previous release} (above): node_modules.prev holds its dependencies."; repair_failed; }
  if [ -d node_modules.prev ]; then
    deps_lock || { echo "Another install of the dependencies in $DIR has held $DEPS_LOCK for half an hour, so ${FROM:-the previous release}'s are still in node_modules.prev, not put back: the next upgrade puts them back first. If no npm is running there, remove it: rm -r \"$DEPS_LOCK\""; repair_failed; }
    rm -rf node_modules; mv node_modules.prev node_modules
    deps_unlock
  fi
  # Written down only if the new release really ran and nothing went back
  # since: a rollback whose restart back did not answer in time kept this
  # record, and the release it went back to may have served since (left_ran).
  # A note written for an older release named, which never started, goes as
  # that run's rollback would have taken it away (unmark_rolled_back, HB-1455);
  # one that started, the rollback saw to.
  GOING=0
  if grep -qx restarted "$FROM_FILE"; then
    NOTED_AT="$(sed -n 's/^noted //p' "$FROM_FILE" | tail -n 1)"
    if left_ran "$FROM_FILE"; then mark_rolled_back "$DIR"; elif [ -n "$NOTED_AT" ] && ! grep -qx started "$FROM_FILE"; then unmark_rolled_back "$DIR" "$NOTED_AT"; fi
    # A restart back that did not come up (restart.sh's health wait) keeps the
    # record, so a later run restarts it again (back_down, kept_check): removed,
    # the service was left down and nothing tried again (HB-1456). The restart
    # tells the record `back` once the service manager has restarted it, so
    # that next repair writes no note over what the release gone back to has
    # kept since (left_ran), as a rollback's restart back does.
    KC=0; kept_check "${FROM:-The previous release}" "$FROM_FILE" $RESTART || KC=$?
    if [ "$KC" = 1 ]; then
      if ! HATCHABOT_RESTART_BACK=1 HATCHABOT_RESTART_RECORD="$FROM_FILE" $RESTART; then
        back_down "${FROM:-The previous release}" "$FROM_FILE"
        stop_or_go "$FROM" "$FROM_FILE"; GOING=1
      fi
    elif [ "$KC" = 2 ]; then stop_or_go "$FROM" "$FROM_FILE"; GOING=1; fi
  fi
  [ "$GOING" = 1 ] || rm -f "$FROM_FILE"
fi
# The repair alone: which release comes next needs the network. A pin a killed
# run left stays recorded for the next full run to see through.
if [ "$REPAIR_ONLY" = 1 ]; then
  PIN_ON=""
  echo "Which release $CHANNEL names is looked for again on the next try."
  exit 0
fi

# What this run follows, read again now the lock is held: the owner (or
# another upgrade) may have pinned a release or named another channel while
# it looked for the release or waited, and going on would undo that. Read
# again for a run that read it from this install's file (none named), for the
# channel timer, which names the channel it read before this ran, and for a
# channel named by hand, written before the lock (tenth and twelfth reviews).
# A version named by hand is the person's own, and stands. Not one of them
# (none at all, or not a channel), the timer follows its own: nothing to read.
# After the repairs above, which need no channel; a pin a killed run left
# stays recorded for the next run to see through.
case "$ARG" in
  ''|stable|beta|latest) RECHECK=1 ;;
  *) RECHECK=0 ;;
esac
[ "${HATCHABOT_UPGRADE_BY_TIMER:-}" != 1 ] || RECHECK=1
if [ "$RECHECK" = 1 ]; then
  NOW="$(remembered_channel)"; [ -n "$NOW" ] || [ -n "$ARG" ] || NOW=stable
  case "$NOW" in
    stable|beta|latest|v[0-9]*) ;;
    *) NOW="" ;;
  esac
  if [ -n "$NOW" ] && [ "$NOW" != "$CHANNEL" ]; then
    # Left as it is, a pin a killed run left is the next run's to see to.
    PIN_ON=""
    # 4, as for a lock another holds: routine, so the timer touches nothing.
    # 0 read as an upgrade done, and the timer forgot the tries of a release
    # it never tried, and the release it had set aside (thirteenth review).
    if [ -z "$ARG" ] && [ "${HATCHABOT_UPGRADE_BY_TIMER:-}" != 1 ]; then
      echo "While this looked for the release $CHANNEL names, another upgrade set this machine to follow $NOW: nothing was changed. Run hatchabot upgrade again to follow $NOW."
    else
      echo "The channel changed while this waited: this machine now follows $NOW, not $CHANNEL, so nothing was changed."
    fi
    exit 4
  fi
fi

# What is installed, read only once the lock is held: read before it, a run
# that waited there while another upgrade moved this machine on judged by the
# release it no longer had, and a channel upgrade took the machine backwards
# (audit #035).
if [ "$BUNDLED" = 1 ]; then CUR="$(sed -nE 's/.*"tag":"([^"]+)".*/\1/p' BUNDLE.json)"
else CUR="$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)"; fi
# Killed once that release was up: it is what is installed, so the pin was kept.
if [ -n "$PIN_ON" ] && [ "$CUR" = "$PIN_ON" ]; then rm -f "$PIN_RECORD"; PIN_ON=""; PRE_CHANNEL=""; PRE_USER_CHANNEL=""; fi
if [ "$CUR" = "$TARGET" ]; then
  # The release put back that is not up (stop_or_go, by another of its names).
  [ -z "$KEPT_REC" ] || kept_end named
  pin_named; echo "Already on $TARGET ($CHANNEL)."; exit 0
fi
case "$CHANNEL" in
  v[0-9]*) ;;
  *)
  # A channel never takes a machine backwards (this one may run ahead of it).
  if [[ "$CUR" == v* ]] && [ "$(vernewer "$CUR" "$TARGET")" = "$CUR" ]; then
    echo "On $CUR, which is newer than $CHANNEL ($TARGET). Nothing to do — name a version to go back."
    [ -z "$KEPT_REC" ] || kept_end
    exit 0
  fi ;;
esac
if [ "$BUNDLED" = 0 ] && [ -n "$(git --no-optional-locks status --porcelain)" ]; then
  echo "$DIR has local changes — an upgrade would overwrite them. Refusing:"; git --no-optional-locks status --porcelain | sed 's/^/    /'; exit 2
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
  # The disk, said as the disk: it read as "no bundle yet", or as a release that
  # would not unpack, and the timer went on trying (HB-0438). A bundle's download
  # and unpacked copy sit beside the install until the swap.
  free_beside() { local mb; mb="$(free_mb "$(dirname "$DIR")")"; [ -z "$mb" ] || printf ' (%s MB free)' "$mb"; }
  disk_full() {
    local free
    free="$(free_beside)"
    echo "The disk holding $(dirname "$DIR") is full$free, so the $TARGET bundle could not be written there: nothing was changed. Free about 1 GB, then try again."
    machine_short
  }
  # A folder that cannot be made there is not always the disk: a parent this user
  # cannot write fails the same way, and "full" sent people freeing space.
  no_stage() {
    local at free
    at="$(dirname "$DIR")"
    if [ ! -w "$at" ]; then
      echo "This user cannot write to $at, where the $TARGET bundle goes until the swap: nothing was changed. Fix that folder's permissions, then try again."
      machine_short
    fi
    free="$(free_beside)"
    echo "Could not make a folder in $at for the $TARGET bundle: no room or no permission there$free: nothing was changed. Free about 1 GB or fix that folder's permissions, then try again."
    machine_short
  }
  STAGE="$(mktemp -d "$(dirname "$DIR")/.hatchabot-next-XXXXXX")" || no_stage
  sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
  # What failed: this machine's disk (curl 23), no such file (a 404; 37 on a
  # file:// test bed), or the network. A version named by hand that is not there
  # is refused; a release a channel names may just not be published yet.
  DL_RC=0; DL_CODE="$(curl -sSL --retry 3 --connect-timeout 10 --max-time 900 --retry-max-time 900 -o "$STAGE/$NAME" -w '%{http_code}' "$BASE/$TARGET/$NAME")" || DL_RC=$?
  case "$DL_RC:$DL_CODE" in
    0:200|0:000) ;;
    23:*) disk_full ;;
    28:*) echo "Timed out downloading the $TARGET bundle (up to 15 minutes per attempt): nothing was changed — try again later."; exit 3 ;;
    0:404|37:*)
      case "$CHANNEL" in
        v[0-9]*) if [ "${HATCHABOT_UPGRADE_BY_TIMER:-}" != 1 ]; then echo "There is no release $TARGET for $PLATFORM: nothing was changed. Check the version, or follow a channel with: hatchabot upgrade stable"; exit 2; fi ;;
      esac
      echo "No bundle for $TARGET on $PLATFORM yet — try again later."; exit 3 ;;
    *) echo "Could not download the $TARGET bundle (curl $DL_RC, HTTP ${DL_CODE:-none}): nothing was changed — try again later."; exit 3 ;;
  esac
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
      WANT="$(curl -fsSL --retry 3 --connect-timeout 10 --max-time 60 --retry-max-time 120 "$BASE/$TARGET/$NAME.sha256" 2>/dev/null | cut -d' ' -f1)" || { echo "Could not fetch the $TARGET bundle's checksum (download failed or timed out after 60 seconds per attempt) — try again later."; exit 3; }
      [ -n "$WANT" ] && [ "$WANT" = "$(sha "$STAGE/$NAME")" ] || { echo "The $TARGET bundle's checksum does not match — not installing it."; exit 3; } ;;
    3) echo "Could not fetch the $TARGET release's manifest to check its bundle — try again later."; exit 3 ;;
    *) echo "Not installing the $TARGET bundle: the release's manifest does not vouch for it (above). Staying on $CUR."; exit 3 ;;
  esac
  TAR_ERR=""
  # In English: its message is matched below.
  TAR_ERR="$(LC_ALL=C tar -xzf "$STAGE/$NAME" -C "$STAGE" 2>&1)" || {
    printf '%s\n' "$TAR_ERR" | tail -n 3
    case "$TAR_ERR" in
      *"No space left"*|*"Disk quota"*) disk_full ;;
    esac
    echo "Could not unpack the $TARGET bundle."; exit 3
  }
  NEW="$STAGE/hatchabot"
  ( cd "$NEW" && ./.node/bin/node -e 'new (require("better-sqlite3"))(":memory:").exec("SELECT 1")' ) >/dev/null 2>&1 || { echo "The $TARGET bundle does not run on this machine — staying on $CUR."; exit 3; }
  # A bundle from before the file list: what it holds is what it has.
  [ -f "$NEW/.bundle-files" ] || ( cd "$NEW" && ls -A > .bundle-files )
  [ -f .bundle-files ] || ls -A "$NEW" > .bundle-files.guess
  OLDLIST="$( [ -f .bundle-files ] && cat .bundle-files || cat .bundle-files.guess )"; rm -f .bundle-files.guess
  # The swap moves node_modules too (the bundle's own, in its .bundle-files):
  # from here to its end under the dependencies' lock, as a git install's move
  # aside, so a restart's install there is not moved from under (review of
  # HB-1212). Taken before anything here changes; let go before the restart,
  # whose ensure-deps.sh takes it.
  deps_lock || { echo "$DEPS_STUCK"; exit 3; }
  pin_named
  # Its own check below says what a failed rm left (set -e stopped here before).
  # A .rollback-scripts here is a leftover too: a swap cut off part-way was
  # put back above (restore_prev takes it in, or stops the run), so none is
  # under way now. Kept, a failed swap's rollback found it and the old
  # scripts/ in $PREV both, could not tell which was the old one, and left
  # the install part-way (eighth review). Under the lock, as all of this.
  rm -rf "$PREV" "$DIR/.rollback-aside" "$DIR/.rollback-scripts" || true
  # Never into what a failed rm left: moved onto, a folder takes the old one inside itself (HB-0071).
  for f in "$PREV" "$DIR/.rollback-aside" "$DIR/.rollback-scripts"; do
    { [ ! -e "$f" ] && [ ! -L "$f" ]; } || { echo "Could not remove $f (above), so nothing was changed. Remove it by hand, then try again."; exit 3; }
  done
  # A move or a record that failed for want of room is the machine's, 5, once
  # the swap is put back. It said 3, and the release counted as a bad one
  # (second and fifth reviews of HB-0470). Each step's errors kept to judge by
  # (run_step) beside the lock, in English.
  STEP_LOG="$(new_step_log)"
  LC_ALL=C run_step mkdir -p "$PREV" || change_failed : "swapped in" "Could not make $PREV (above), so nothing was changed."
  # What came in from the new bundle is written in .swapping (above), one name
  # a line, BEFORE it moves: a swap that stops part-way (a failed mv, or this
  # run killed) is undone from that and $PREV, not from a file list that may
  # itself be half moved.
  rollback_bundle() {
    echo "Rolling back to ${CUR}…"
    # The unpacked bundle first: on the disk that filled, the rollback needs
    # room for its record (twelfth review). Whatever of it did not move in is
    # not wanted, and this run wrote each `in` after moving the old one aside,
    # so restore_prev needs none of it to tell the two apart (HB-0279 is an
    # older upgrade.sh's order).
    [ -z "$STAGE" ] || rm -rf "$STAGE" || true
    STAGE_FREED=1   # restore_prev: what this run put back is what it knows of (back)
    # Under the dependencies' lock (held already when a move of the swap
    # failed), let go before the restart. One this run cannot have leaves the
    # old files where they are and fails: the record stays for the repair.
    if ! deps_lock; then
      echo "Another install of the dependencies in $DIR has held $DEPS_LOCK for half an hour, so ${CUR}'s files were left in $PREV, not put back. If no npm is running there, remove it: rm -r \"$DEPS_LOCK\""
      return 1
    fi
    # The old release's restart, on its own Node — only when the service was
    # restarted onto the new one; otherwise the old release never stopped, and
    # a record kept from before this run is as it was (kept_again).
    # Written down only if the new one really ran (left_ran); a note this run
    # wrote for an older release named that never started goes (NOTED). Before
    # the files go back, as the repair's. Not come up, its own record stays for
    # the next run (restart_back, HB-1456).
    if [ "$RESTARTED" = 1 ]; then
      if left_ran "$SWAPPING"; then mark_rolled_back "$DIR"; elif [ "$NOTED" = 1 ]; then unmark_rolled_back "$DIR"; fi
      NOTED=0
      restore_prev "$CUR" || return 1
    else
      restore_prev || return 1
    fi
    deps_unlock
    [ "$RESTARTED" = 1 ] || [ -z "$KEPT_REC" ] || kept_again
    [ "$RESTARTED" = 0 ] || restart_back "$CUR" || { BACK_DOWN=1; return 1; }
    return 0
  }
  undo() { rollback_bundle; }
  # A rollback once the service was restarted, which did not work: the record
  # stays and the next run repairs from it. Said, with what to run, as
  # change_failed says it; it ended with exit 1 and no next step (review of
  # HB-1212). Still 1: the release itself did not come up.
  # Back, and only its restart did not come up: restart_back said what comes next.
  rollback_or_redo() {
    rollback_bundle && return 0
    [ "$BACK_DOWN" = 1 ] || { echo "So the rollback did not finish either: ${CUR:-the previous release} is not back as it was."; echo "Then run $REDO: it puts ${CUR:-the previous release} back first, from its record."; }
  }
  # By its words too: a move across file systems that ran out of room removes
  # its part copy, and the space it took is free again (third review).
  swap_failed() { change_failed undo "swapped in" "$1" "The upgrade stopped part-way — putting $CUR back."; }
  CHANGING=1
  # Written beside it, then renamed over it: written in place, a full disk
  # cut short a record kept for a release put back (stop_or_go) as this run
  # went on from it, and only this run's rollback wrote it back (HB-1468).
  { LC_ALL=C run_step put_rec "$SWAPPING.tmp" '>' "from $CUR" "to $TARGET" "stage $STAGE" "$PINS_RECORDED" says-started && LC_ALL=C run_step mv -f "$SWAPPING.tmp" "$SWAPPING"; } || {
    rm -f "$SWAPPING.tmp" 2>/dev/null || true
    swap_failed "Could not write $SWAPPING (above)."
  }
  went_on
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
    if [ -e "$DIR/$f" ]; then LC_ALL=C run_step mv "$DIR/$f" "$PREV/" || swap_failed "Could not move $DIR/$f aside."; fi
    LC_ALL=C run_step put_rec "$SWAPPING" '>>' "in $f" || swap_failed "Could not write $SWAPPING (above)."
    LC_ALL=C run_step mv "$NEW/$f" "$DIR/" || swap_failed "Could not move the new $f into $DIR."
  done < <(grep -x scripts "$NEW/.bundle-files" || true; grep -vx scripts "$NEW/.bundle-files" || true)
  # What the old release had and this one does not.
  while IFS= read -r f; do
    [ -n "$f" ] && [ -e "$DIR/$f" ] || continue
    ! not_ours "$f" || continue
    ! grep -qxF "in $f" "$SWAPPING" || continue
    LC_ALL=C run_step mv "$DIR/$f" "$PREV/" || swap_failed "Could not move $DIR/$f aside."
  done < <(printf '%s\n' "$OLDLIST")   # not <<<: bash 3.2 writes that to a temporary file, on the disk that may be full
  deps_unlock
  LC_ALL=C run_step put_rec "$SWAPPING" '>>' restarted || swap_failed "Could not write $SWAPPING (above)."
  RESTARTED=1
  # Going back by naming an older release is a rollback too (mark_rolled_back).
  if older_release "$TARGET" "$CUR"; then mark_rolled_back "$DIR" "$SWAPPING"; NOTED=1; fi
  # The record told when the service manager has restarted it (left_ran).
  HATCHABOT_RESTART_RECORD="$SWAPPING" PATH="$DIR/.node/bin:$PATH" "$DIR/scripts/restart.sh" || { CHANGING=0; ROLLED_BACK=1; rollback_or_redo || true; exit 1; }
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
# restore_deps (scripts/upgrade-helpers.sh) puts it back, under the
# dependencies' lock.
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
    checkout_recorded --quiet --force "$TARGET" || return 1
  fi
  checkout_recorded --quiet --force "$CUR"
}
rollback() {
  echo "Rolling back to ${CUR}…"
  # The dependencies go back whether or not the checkout could: left aside, the
  # running service had none until someone came. The record stays for the repair.
  local back=0
  back_to_cur || back=1
  restore_deps || back=1
  [ "$back" = 0 ] || return 1
  # Written down only if the new release really ran (left_ran); a note this
  # run wrote for an older release named that never started goes (NOTED).
  # The restart back tells the record once the service is back, so a repair
  # after one that did not answer in time writes nothing more.
  if [ "$RESTARTED" = 1 ]; then
    if left_ran "$FROM_FILE"; then mark_rolled_back "$DIR"; elif [ "$NOTED" = 1 ]; then unmark_rolled_back "$DIR"; fi
    NOTED=0
    HATCHABOT_RESTART_BACK=1 HATCHABOT_RESTART_RECORD="$FROM_FILE" $RESTART || { back_down "$CUR" "$FROM_FILE"; BACK_DOWN=1; return 1; }
  fi
}
undo() {
  rollback || return 1
  if [ "$RESTARTED" = 0 ] && [ -n "$KEPT_REC" ]; then kept_again; else rm -f "$FROM_FILE"; fi
  return 0
}
# As the bundle's (above): a rollback after the restart that did not work
# keeps the record, and says what to run (review of HB-1212); one back whose
# restart alone did not come up, back_down said it.
rollback_or_redo() {
  undo && return 0
  [ "$BACK_DOWN" = 1 ] || { echo "So the rollback did not finish either: ${CUR:-the previous release} is not back as it was."; echo "Then run $REDO: it puts ${CUR:-the previous release} back first, from its record."; }
}
# An upgrade killed (or a power cut) right after moving node_modules aside
# left node_modules.prev as the only working copy. Put back first: deleted as
# a leftover, a failed install then had nothing to roll back to (audit #033).
# From here to the move aside below, under the dependencies' lock
# (deps_lock): taken before the record, so one this run cannot have changes
# nothing.
deps_lock || { echo "$DEPS_STUCK"; exit 3; }
[ -d node_modules ] || [ ! -d node_modules.prev ] || mv node_modules.prev node_modules
# A leftover, removed before the record is written: half removed under it,
# the next run's repair would move it in as the old release's.
rm -rf node_modules.prev
# Another git's lock, with nothing moved yet: the checkout would fail on it,
# and the rollback's too, with the dependencies aside (HB-0372).
[ ! -e .git/index.lock ] || { echo "$DIR/.git/index.lock is held, so nothing was changed — try again later. If no git is running there, remove it: rm $DIR/.git/index.lock"; exit 3; }
pin_named
# Written before anything moves, so a disk too full for it changes nothing;
# judged as any record is (put_failed: it was always the disk, seventh review).
PRC=0; put_line "$FROM_FILE" "from $CUR" "to $TARGET" "$PINS_RECORDED" says-started || PRC=$?
[ "$PRC" = 0 ] || put_failed "$PRC" "Could not write $FROM_FILE (a full disk, or no permission there?), so nothing was changed. Free some space, then try again."
went_on
CHANGING=1
if [ -d node_modules ]; then mv node_modules node_modules.prev; fi; ASIDE=1
deps_unlock
# The checkout or the install failed, and the old release goes back. Exit 3,
# usually something passing, unless the disk is what stopped it: a disk that
# filled here exited 3 too, and the timer set the release aside after 8 tries
# (review of HB-0470). Judged before the rollback frees what the step wrote
# (change_failed). The step's errors beside the lock, not in TMPDIR (fourth
# review) unless that folder takes no new file (new_step_log), and in English, so disk_short reads "No space left on device"
# whatever the locale.
STEP_LOG="$(new_step_log)"
LC_ALL=C run_step checkout_recorded --quiet "$TARGET" || change_failed undo "checked out" "The upgrade stopped part-way — putting $CUR back."
# The install's messages in English, which the step's words are judged by, and
# the rest of the locale the user's: LC_ALL=C over the whole install set every
# category, and builds lost the user's (fourteenth review). The user's LC_ALL,
# which would override LC_MESSAGES, becomes LANG, the fallback for the rest.
LANG="${LC_ALL:-${LANG-}}" LC_ALL= LC_MESSAGES=C run_step $INSTALL || change_failed undo installed
LC_ALL=C run_step put_rec "$FROM_FILE" '>>' restarted || change_failed undo started "Could not write $FROM_FILE (above)."
RESTARTED=1
# Going back by naming an older release is a rollback too (mark_rolled_back).
if older_release "$TARGET" "$CUR"; then mark_rolled_back "$DIR" "$FROM_FILE"; NOTED=1; fi
# The record told when the service manager has restarted it (left_ran).
HATCHABOT_RESTART_RECORD="$FROM_FILE" $RESTART || { CHANGING=0; ROLLED_BACK=1; rollback_or_redo || true; exit 1; }
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
# On the daemon the service uses: the one .env names (a tenant's rootless daemon
# on a shared host); neither this shell nor the timer has .env, so the image
# was looked for and fetched on the default daemon, and the service's kept the
# old one (HB-0431). The last line wins.
# And the image the service runs agents on and the mirror it pulls from, as
# .env names them (HATCHABOT_IMAGE, HATCHABOT_IMAGE_REGISTRY), for the same
# reason: hatchabot-runtime:latest was looked at whatever the service used,
# and the fetch went to the default repository from the default registry. The
# service's own image never moved, and one named only in this shell was
# judged by the default's version, so a newer one promoted there was taken
# back to this release's default (HB-0984).
# All three read from .env as the service reads it, and as setup-host.sh now
# reads them (env_named, the same function there, held so by
# test/backupKeyLine.test.ts): on Linux by systemd's EnvironmentFile rules,
# where spaces around the = count and a " # ..." after a value is part of it;
# on a Mac as its launchd job reads it, sourced by bash in a subshell. Read by
# sed (NAME= at the start of a line, a comment taken off), a line
# `HATCHABOT_IMAGE = x` was the service's image and setup's, but not the
# upgrade's: setup fetched x, the upgrade the default (review of HB-1210).
# (env_named is defined above, with rolled_back_note, which reads .env too.)
# The daemon is the service's alone, as doctor asks it (serviceDockerEnv):
# this shell's DOCKER_CONTEXT, DOCKER_TLS_VERIFY and DOCKER_CERT_PATH, and its
# DOCKER_HOST when .env names none, pointed the look and the fetch at another
# daemon (HB-1354), and so did its DOCKER_CONFIG, whose config.json's
# currentContext names one too. They go once .env is read through, or when
# there is none (the service then has none).
DAEMON_SETTINGS="DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_CONFIG"
if [ "${HATCHABOT_UPGRADE_IMAGE:-1}" = 1 ] && command -v docker >/dev/null 2>&1; then
  ENV_READ=1
  if [ -f .env ]; then
    env_named $DAEMON_SETTINGS HATCHABOT_IMAGE HATCHABOT_IMAGE_REGISTRY
    # Not read through (on Linux with no node, a line only systemd reads so):
    # said, where the shell's settings were taken in silence (HB-1381).
    [ -n "$ENV_READ" ] || echo "⚠ Could not read $DIR/.env as the service reads it (on Linux, with no node on this PATH, only plain NAME=value lines can be), so the runtime image is checked with this shell's DOCKER_HOST, DOCKER_CONTEXT, DOCKER_TLS_VERIFY, DOCKER_CERT_PATH, DOCKER_CONFIG, HATCHABOT_IMAGE and HATCHABOT_IMAGE_REGISTRY, which may not be the service's."
  fi
  if [ -n "$ENV_READ" ]; then for v in $DAEMON_SETTINGS; do unset "$v"; done; fi
  for v in $DAEMON_SETTINGS HATCHABOT_IMAGE HATCHABOT_IMAGE_REGISTRY; do
    set_in="ENVSET_$v"; val="ENV_$v"
    [ -n "${!set_in:-}" ] || continue
    if [ -n "${!val}" ]; then export "$v=${!val}"; else unset "$v"; fi
  done
  WANT="$(sed -n 's/^ARG OPENCLAW_VERSION=//p' docker/Dockerfile.runtime | sed -n 1p)"
  IMAGE="${HATCHABOT_IMAGE:-hatchabot-runtime:latest}"
  # The fetch moves :latest of the image's repository (build-runtime-image.sh,
  # REPO), so that is the one looked at. An image named by another tag (or a
  # digest) is one the owner pinned, which no fetch moves: it is left as it is.
  IMAGE_REPO="$(printf '%s' "$IMAGE" | sed 's/:[^:/]*$//')"
  if [ "$IMAGE" != "$IMAGE_REPO" ] && [ "$IMAGE" != "$IMAGE_REPO:latest" ] || [ "$IMAGE" != "${IMAGE%@*}" ]; then
    echo "The runtime image is pinned to $IMAGE (HATCHABOT_IMAGE): the upgrade leaves it as it is (this release's default is OpenClaw ${WANT:-unknown})."
    WANT=""
  fi
  # HATCHABOT_IMAGE_REPO, a by-hand override in this shell, is looked at and
  # fetched into, where the app and its image list never look: said, and how
  # to bring the image into the fleet's repository (HB-1386).
  if [ -n "$WANT" ] && [ -n "${HATCHABOT_IMAGE_REPO:-}" ] && [ "$HATCHABOT_IMAGE_REPO" != "$IMAGE_REPO" ]; then
    echo "⚠ HATCHABOT_IMAGE_REPO (set in this shell) names $HATCHABOT_IMAGE_REPO, not the fleet's repository $IMAGE_REPO (HATCHABOT_IMAGE): the runtime image is looked at and fetched there, where the app and its image list do not look. To use one fetched there, run the upgrade without HATCHABOT_IMAGE_REPO, or tag it in:  docker tag $HATCHABOT_IMAGE_REPO:latest $IMAGE_REPO:latest"
  fi
  HAVE=""
  [ -z "$WANT" ] || HAVE="$(docker image inspect "${HATCHABOT_IMAGE_REPO:-$IMAGE_REPO}:latest" --format '{{ index .Config.Labels "org.agentclaw.openclaw-version" }}' 2>/dev/null || true)"
  # No version label (an old or hand-built image) is what docker prints as
  # "<no value>": OpenClaw unknown, so older, as setup-host.sh has it (HB-0041).
  # Compared as a version, sort -V put every real version before it, and the
  # upgrade never fetched over such an image while setup replaced it (HB-1211).
  [ "$HAVE" != "<no value>" ] || HAVE=""
  # Only upwards: a promoted candidate newer than the default stays.
  if [ -n "$WANT" ] && [ "$HAVE" != "$WANT" ] && { [ -z "$HAVE" ] || [ "$(printf '%s\n%s\n' "$HAVE" "$WANT" | sed 's/-/~/' | sort -V | sed -n 1p)" = "$(printf '%s' "$HAVE" | sed 's/-/~/')" ]; }; then
    echo "The runtime image here carries OpenClaw ${HAVE:-nothing}; this release's default is $WANT — fetching it (a few GB; agents move to it on their next rebuild)…"
    ./scripts/build-runtime-image.sh || echo "⚠ Could not fetch the $WANT image now — run ./scripts/build-runtime-image.sh later, or Settings → Images."
  fi
fi
