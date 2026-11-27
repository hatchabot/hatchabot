#!/usr/bin/env bash
# Keep this install on a release channel, on its own.
#
#   scripts/follow-channel.sh stable              # upgrade now if the channel moved on
#   scripts/follow-channel.sh --install stable    # check every 10 minutes (systemd --user timer)
#   scripts/follow-channel.sh --uninstall
#
# Channels as everywhere else: stable and beta are named in channels.json on
# main (promote.sh moves them), latest is the newest tag. The upgrade itself
# is upgrade.sh's: forward only, and the previous release restored if the new
# one does not come up. A release that failed is remembered and not retried;
# the channel naming a newer one clears it.
#
# The channel it follows is the one chosen last for this install, in its
# data/channel (`hatchabot upgrade beta`, the installer, --install here; before
# v2.169.0 one ~/.config/hatchabot/channel for every install of the user's,
# still read when the install has none of its own: HB-0235); the timer's own
# argument only when none is (a version there is a pin: the timer waits).
#
# For installs that follow a channel unattended — a hosted tenant on stable,
# a canary on beta. (The development machine, which serves from a separate
# checkout, has follow-latest.sh.)
set -euo pipefail
[ -x "$(dirname "$0")/../.node/bin/node" ] && PATH="$(cd "$(dirname "$0")/.." && pwd)/.node/bin:$PATH" && export PATH  # a bundle install's own Node (install.sh)
cd "$(dirname "$0")/.."
DIR="$PWD"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/hatchabot"
UNITS="$HOME/.config/systemd/user"
NAME=hatchabot-follow-channel
CHANNEL_FILE="$DIR/data/channel"; USER_CHANNEL_FILE="$HOME/.config/hatchabot/channel"

valid() { case "${1:-}" in stable|beta|latest) return 0 ;; *) return 1 ;; esac; }

if [ "${1:-}" = --install ]; then
  valid "${2:-}" || { echo "Usage: $0 --install stable|beta|latest"; exit 1; }
  command -v systemctl >/dev/null 2>&1 || { echo "This needs systemd (Linux). On a Mac, run 'hatchabot upgrade' from time to time."; exit 1; }
  mkdir -p "$UNITS"
  # The install folder goes in ExecStart's quotes as systemd reads them: a
  # backslash or quote escaped, % and $ doubled (install-%q, audit 2026-10-29).
  # The user manager's PATH does not include a node installed by nvm or
  # Homebrew. Quoted whole, as install-service.sh writes it (audit #044).
  # Not found here, refused: a guessed path baked into the unit failed every
  # tick later, out of sight (HB-0042).
  NODE_BIN="$(command -v node)" || { echo "node not found on PATH — run this from a shell where 'node --version' works." >&2; exit 1; }
  DOCKER_BIN="$(command -v docker)" || { echo "docker not found on PATH — run this from a shell where 'docker version' works." >&2; exit 1; }
  UNIT_PATH="$(dirname "$NODE_BIN"):$(dirname "$DOCKER_BIN"):/usr/local/bin:/usr/bin:/bin"
  . scripts/systemd-quote.sh
  cat > "$UNITS/$NAME.service" <<UNIT
[Unit]
Description=Hatchabot: follow the release channel chosen last (installed for $2)

[Service]
Type=oneshot
Environment="PATH=$(systemd_quoted "$UNIT_PATH")"
ExecStart=/usr/bin/env bash "$(systemd_arg "$DIR")/scripts/follow-channel.sh" $2
UNIT
  cat > "$UNITS/$NAME.timer" <<UNIT
[Unit]
Description=Hatchabot: check the release channel every 10 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
RandomizedDelaySec=2min
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now "$NAME.timer"
  # Remembered, as `hatchabot upgrade $2` would: each tick follows the channel chosen last.
  mkdir -p "$(dirname "$CHANNEL_FILE")"; echo "$2" > "$CHANNEL_FILE"
  echo "This install now follows $2. Logs: journalctl --user -u $NAME"
  echo "Stop with: $0 --uninstall"
  exit 0
fi
if [ "${1:-}" = --uninstall ]; then
  systemctl --user disable --now "$NAME.timer" 2>/dev/null || true
  rm -f "$UNITS/$NAME.service" "$UNITS/$NAME.timer"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Stopped following a channel. Upgrade by hand with: hatchabot upgrade"
  exit 0
fi

CHANNEL="${1:-}"
valid "$CHANNEL" || { echo "Usage: $0 stable|beta|latest   (or --install <channel>, --uninstall)"; exit 1; }
# The channel chosen last wins over the one this timer was installed with:
# `hatchabot upgrade beta` said it switched, while every tick went on
# following stable (audit #043).
remembered() {
  if [ -f "$CHANNEL_FILE" ]; then tr -d '[:space:]' < "$CHANNEL_FILE"
  elif [ -f "$USER_CHANNEL_FILE" ]; then tr -d '[:space:]' < "$USER_CHANNEL_FILE"; fi
}
REMEMBERED="$(remembered)"
# This install's own records, keyed on its path as the upgrade lock is: one
# file for every install of the user's let a release that failed on one set
# it aside on another, which then stayed behind (audit #034). The records
# from before (unkeyed) are taken over by the first install that looks.
KEY="$(printf %s "$DIR" | cksum | cut -d' ' -f1)"
# Pinned by hand to a version (hatchabot upgrade vX.Y.Z): leave it there. But
# not half-way: that upgrade killed (a swap cut off, its record beside the lock,
# or the note of what the pin replaced, there from before the pin until the
# release is up) goes to upgrade.sh, for the release pinned, which it puts the
# earlier one back for and then finishes. If it cannot finish, it takes the pin
# back. Left for the next hand upgrade, the install stayed half changed under a
# running timer (HB-0372), or pinned to a release it never got, with this timer
# quiet for good (HB-0428).
# That record, and the release it names (`from`). A kept one (kept_record, a
# copy of upgrade-helpers.sh's) is of a release put back whose restart did
# not come up: no upgrade was cut off, and past the cap of restarts it is
# only looked at (review of HB-1456). Said so wherever the tick
# would speak of an upgrade cut off (HB-1468).
cut_rec() { if [ -f .swapping ]; then echo .swapping; else echo "$STATE/upgrade-$KEY.from"; fi; }
kept_record() { grep -qx back "$1" 2>/dev/null || grep -q '^tries ' "$1" 2>/dev/null; }
put_back() { local r; r="$(sed -n 's/^from //p' "$(cut_rec)" 2>/dev/null | sed -n 1p || true)"; echo "${r:-$1}"; }
PINNED=""
# An upgrade cut off: a bundle swap (.swapping), or a git install's record
# beside the lock. A pin's record alone is no cut: that upgrade.sh sees
# through, or takes back.
cut_due() { [ -f .swapping ] || [ -f "$STATE/upgrade-$KEY.from" ]; }
# No cut left to repair: the repair's clock (below; FILE.repair beside the
# try record, scripts/follow-tries.sh) goes with it, here, before a tick
# that is up to date, pinned or set aside ends without reading that record.
# Left, the failures of a cut repaired by hand made the next cut's first
# failed repair wait as long as the last one's (review of HB-1431).
cut_due || rm -f "$STATE/follow-channel-tries-$KEY.repair" 2>/dev/null || true
# The repair's own clock (HB-1431, scripts/follow-tries.sh): an upgrade.sh
# whose repair of an upgrade cut off failed before the release was touched
# (7) is no try of the release; the next repair waits, doubling to an hour,
# wherever it runs. repair_clock reads it, with stand-ins for a helper from
# before it (or none), under which such a repair runs on every tick, as
# before, and is said to (REPAIR_EVERY_TICK). repair_ended RC: after an
# upgrade.sh that ended RC, one more failed repair (7), said; with no cut
# left, the clock goes.
REPAIR_EVERY_TICK=""
repair_clock() {
  declare -F repair_open repair_waiting note_repair forget_repair >/dev/null || {
    REPAIR_EVERY_TICK=1
    repair_open() { R_COUNT=0; R_LAST=0; }
    repair_waiting() { return 1; }
    note_repair() { :; }
    forget_repair() { :; }
  }
  TRIES="$STATE/follow-channel-tries-$KEY"; repair_open
}
repair_ended() {
  if [ "$1" = 7 ]; then
    note_repair
    if [ -n "$REPAIR_EVERY_TICK" ]; then
      echo "The repair did not go through (above)${TARGET:+, and $TARGET was not touched}: it is tried again on the next tick.${TARGET:+ This does not count against $TARGET.}"
    else
      echo "The repair did not go through (above)${TARGET:+, and $TARGET was not touched}: it is tried again later, less and less often (an hour apart at most).${TARGET:+ This does not count against $TARGET.}"
    fi
  elif ! cut_due; then forget_repair; fi
}
repair_due() { [ -f .swapping ] || [ -f "$STATE/upgrade-$KEY.from" ] || { [ -n "$PINNED" ] && [ -f "$STATE/upgrade-$KEY.pin" ]; }; }
case "$REMEMBERED" in v[0-9]*)
  [ -f .swapping ] || [ -f "$STATE/upgrade-$KEY.from" ] || [ -f "$STATE/upgrade-$KEY.pin" ] || exit 0
  PINNED="$REMEMBERED" ;;
esac
if [ -n "$PINNED" ]; then CHANNEL="$PINNED"; TARGET="$PINNED"
else
if valid "$REMEMBERED"; then CHANNEL="$REMEMBERED"; fi

# What the channel names now — the same resolution as upgrade.sh, needed here
# only to remember a failure and not retry it every ten minutes.
# (A bundle install has no clone: release-target.sh asks GitHub instead.)
TARGET="$("$DIR/scripts/release-target.sh" "$CHANNEL" 2>/dev/null)" || TARGET=""
if [ -z "$TARGET" ]; then
  # Not found (no network, as a rule). An upgrade cut off part-way is still
  # repaired from what is on this machine: it used to wait for the network,
  # with the service half changed meanwhile (HB-0547). The release waits for
  # a tick that can find it, and no try is counted against it.
  repair_due || exit 0
  # A repair that failed (7) waits on its own clock, which needs no release (HB-1431).
  { [ -r scripts/follow-tries.sh ] && . scripts/follow-tries.sh; } 2>/dev/null || true
  mkdir -p "$STATE" 2>/dev/null || true
  repair_clock
  ! repair_waiting || exit 0
  if kept_record "$(cut_rec)"; then echo "Could not find which release $CHANNEL names now, so only $(put_back 'the release put back'), which was not up, is looked at again."
  else echo "Could not find which release $CHANNEL names now, so only the upgrade that was cut off is repaired."; fi
  # As below: 4 (another upgrade holds the lock, and repairs it) is routine,
  # 0; anything else that failed, a full disk (5) too, 1, a failed unit to
  # see. Nothing is counted against a release here (ninth review).
  rc=0; HATCHABOT_UPGRADE_BY_TIMER=1 HATCHABOT_UPGRADE_REPAIR_ONLY=1 HATCHABOT_FOLLOW_KNOWS_7=1 bash "$DIR/scripts/upgrade.sh" "$CHANNEL" || rc=$?
  repair_ended "$rc"
  case "$rc" in 0|4) exit 0 ;; *) exit 1 ;; esac
fi
fi
if [ -f BUNDLE.json ] && [ ! -d .git ]; then CUR="$(sed -nE 's/.*"tag":"([^"]+)".*/\1/p' BUNDLE.json)"
else CUR="$(git describe --tags --exact-match 2>/dev/null || true)"; fi
# A bundle swap that was cut off (.swapping) may have the new BUNDLE.json in
# already, and a git install's upgrade killed part-way (its record beside the
# lock) the new release checked out with half its dependencies: upgrade.sh
# repairs both, so it runs (HB-0049, HB-0266).
[ "$CUR" = "$TARGET" ] && ! repair_due && exit 0
mkdir -p "$STATE"
FAILED="$STATE/follow-channel-failed-$KEY"
TRIES="$STATE/follow-channel-tries-$KEY"
for r in failed tries; do
  [ ! -f "$STATE/follow-channel-$r" ] || [ -e "$STATE/follow-channel-$r-$KEY" ] || mv -f "$STATE/follow-channel-$r" "$STATE/follow-channel-$r-$KEY" || true
done
# A release set aside stays aside, and one whose last try failed waits its
# turn, a cut swap or a killed upgrade to repair or not (below).
if ! repair_due && [ "$(cat "$FAILED" 2>/dev/null)" = "$TARGET" ]; then exit 0; fi
# A release whose install keeps failing waits longer each time, then is set
# aside; a full disk waits the same way, never counted against it: the try
# record (scripts/follow-tries.sh, shared with follow-latest.sh).
# Missing or unreadable (a checkout cut off, a permission), it must not stop
# the tick before the repair (fifth review): stand-ins that count nothing.
if ! { [ -r scripts/follow-tries.sh ] && . scripts/follow-tries.sh && declare -F tries_open tries_waiting note_try forget_tries >/dev/null; }; then
  echo "Could not read $DIR/scripts/follow-tries.sh: this tick keeps no count of its tries, and tries the upgrade."
  MAX_TRIES=8
  tries_open() { T_COUNT=0; T_LAST=0; T_DISK=0; }
  tries_waiting() { return 1; }
  note_try() { :; }
  forget_tries() { :; }
fi
tries_open "$TRIES" "hatchabot-follow-channel-tries-$KEY" "$TARGET"
repair_clock
# With an upgrade cut off part-way (cut_due), on a tick the release is not
# due (set aside, or within its wait) upgrade.sh repairs it and does nothing
# more, as when the release cannot be looked up; nothing is counted. A full
# upgrade repairs it too, so it ran in its place on every tick: one that kept
# failing with the record left ran every ten minutes, and set aside was
# tried again on the next (review of HB-0637). A repair that failed (7)
# waits on its own clock, the full upgrade too, which would run it first:
# counted against the release, a repair that kept failing set it aside for
# good (HB-1431).
# disk_waiting: 0 while the wait after the disk's last failure lasts (an
# hour at most), from that failure (T_DLAST), as follow-latest.sh has it.
# A repair the disk stopped (5) is counted the disk's (note_try 2), not a
# try of the release, nor its clock moved: uncounted, it ran every ten
# minutes while the disk stayed full (review of HB-0637).
disk_waiting() { [ "$T_DISK" -gt 0 ] && ( T_COUNT="$T_DISK"; T_LAST="${T_DLAST:-$T_LAST}"; tries_waiting ); }
TAG_HELD=""
if [ "$(cat "$FAILED" 2>/dev/null)" = "$TARGET" ]; then TAG_HELD="was set aside, so it is not tried again; the channel's next release will be"
elif tries_waiting; then TAG_HELD="is tried again later"; fi
! cut_due || ! repair_waiting || exit 0
if [ -n "$TAG_HELD" ] && cut_due; then
  ! disk_waiting || exit 0
  REPAIRING="Repairing the upgrade that was cut off"
  if kept_record "$(cut_rec)"; then
    REPAIRING="Looking again at $(put_back 'the release put back')"
    echo "$TARGET $TAG_HELD. This tick looks again at $(put_back 'the release put back'), which was not up, and only that."
  else echo "$TARGET $TAG_HELD. This tick repairs the upgrade that was cut off, and only that."; fi
  rc=0; HATCHABOT_UPGRADE_BY_TIMER=1 HATCHABOT_UPGRADE_REPAIR_ONLY=1 HATCHABOT_FOLLOW_KNOWS_7=1 bash "$DIR/scripts/upgrade.sh" "$CHANNEL" || rc=$?
  repair_ended "$rc"
  if [ "$rc" = 5 ]; then
    note_try 2
    echo "$REPAIRING could not go ahead on this machine's disk (see above); it will be tried again later. This does not count against $TARGET."
  fi
  case "$rc" in 0|4) exit 0 ;; *) exit 1 ;; esac
fi
repair_due || ! tries_waiting || exit 0
# set_aside RELEASE SAID AFTER: RELEASE is not tried again (FAILED names it)
# and its record of tries goes; SAID and AFTER are said. FAILED is written
# whole or not at all, and never ends the tick: `>` on a full disk left it cut
# short, and under set -e ended the tick before anything was counted, so the
# next tick ran the release again at once (thirteenth review). Not written,
# the try is counted instead, so the next ones still wait.
set_aside() {
  if { printf '%s\n' "$1" > "$FAILED.tmp" && mv -f "$FAILED.tmp" "$FAILED"; } 2>/dev/null; then
    forget_tries
    echo "$2 $3"
  else
    rm -f "$FAILED.tmp" 2>/dev/null || true
    echo "$2 Could not write $FAILED to set $1 aside (a full disk?): this try is counted instead, so the next ones wait."
    note_try 0
  fi
}

# upgrade.sh runs from its own copy (it checks out a different release of
# itself), so calling it from here is safe. HATCHABOT_UPGRADE_BY_TIMER: it
# leaves the remembered channel alone — someone may have switched it by hand.
# HATCHABOT_UPGRADE_TARGET: the release resolved above, not the channel again —
# a channel that moved in between had the release upgrade.sh tried fail, this
# one set aside, and the next tick try the failed one again (audit #042).
if HATCHABOT_UPGRADE_BY_TIMER=1 HATCHABOT_UPGRADE_TARGET="$TARGET" HATCHABOT_FOLLOW_KNOWS_7=1 bash "$DIR/scripts/upgrade.sh" "$CHANNEL"; then
  rm -f "$FAILED"; forget_tries; forget_repair
else
  rc=$?
  repair_ended "$rc"
  # Exit 1 = the release did not start and was rolled back: set aside at once.
  # 3 = it did not complete (the install step, the network): tried again, less
  # and less often. 5 = this machine's disk (full, or a folder it cannot
  # write): tried again the same way, never set aside for it. 2 = refused
  # (local changes), 4 = an upgrade was running, or the channel changed while
  # this waited: routine, the tick ends 0 and counts nothing (ninth and
  # thirteenth reviews). A full disk (5) ends 1, so the unit shows
  # it failed, but counts only towards the wait, never against the release.
  # 6 = the release put back by an earlier upgrade is not up, and this tick
  # had nothing to upgrade it to (the channel names it, or an older one):
  # nothing was tried, so nothing is counted; it ends 1, a failed unit to see
  # (review of HB-1456). Named as the record names it: TARGET may be older.
  # 7 = its repair of the upgrade cut off before it failed, before TARGET was
  # touched: the repair's own clock (repair_ended), nothing counted (HB-1431).
  # But a pin upgrade.sh took back is not tried again: the channel is, next tick.
  if [ "$rc" = 4 ]; then
    echo "Another upgrade of $DIR is running, or this machine's channel changed while this tick waited (above): it leaves $TARGET to the next tick."
    exit 0
  elif [ "$rc" = 6 ]; then
    echo "$(put_back 'The release put back') is on this machine but not up (above), and there was nothing to upgrade it to. This does not count against $TARGET."
  elif [ "$rc" != 1 ] && [ -n "$PINNED" ] && [ "$(remembered)" != "$PINNED" ]; then
    echo "Upgrading to $PINNED did not complete (see above), so this machine is no longer pinned to it."
  elif [ "$rc" = 7 ]; then
    :
  elif [ "$rc" = 1 ]; then
    set_aside "$TARGET" "Upgrading to $TARGET failed and was rolled back." "It will not be retried; the channel's next release will be."
  elif [ "$rc" = 3 ] && [ $((T_COUNT + 1 - T_DISK)) -ge "$MAX_TRIES" ]; then
    set_aside "$TARGET" "Upgrading to $TARGET did not complete $MAX_TRIES times in a row." "It will not be retried; the channel's next release will be (or run: hatchabot upgrade $CHANNEL)."
  elif [ "$rc" = 3 ]; then
    echo "Upgrading to $TARGET did not complete (see above); it will be tried again later ($((T_COUNT + 1 - T_DISK)) of $MAX_TRIES)."
    note_try 0
  elif [ "$rc" = 5 ]; then
    note_try 1
    echo "Upgrading to $TARGET could not start on this machine's disk (see above); it will be tried again later. This does not count against $TARGET."
  else
    echo "Upgrading to $TARGET did not complete (see above); it will be tried again."
  fi
  exit 1
fi
