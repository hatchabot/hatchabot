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
PINNED=""
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
  echo "Could not find which release $CHANNEL names now, so only the upgrade that was cut off is repaired."
  # As below: 4 (another upgrade holds the lock, and repairs it) is routine,
  # 0; anything else that failed, a full disk (5) too, 1, a failed unit to
  # see. Nothing is counted here (ninth review).
  rc=0; HATCHABOT_UPGRADE_BY_TIMER=1 HATCHABOT_UPGRADE_REPAIR_ONLY=1 bash "$DIR/scripts/upgrade.sh" "$CHANNEL" || rc=$?
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
# A release set aside stays aside, but not with a cut swap or a killed
# upgrade to repair: upgrade.sh puts the earlier release back first, then
# tries this one once more.
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
if HATCHABOT_UPGRADE_BY_TIMER=1 HATCHABOT_UPGRADE_TARGET="$TARGET" bash "$DIR/scripts/upgrade.sh" "$CHANNEL"; then
  rm -f "$FAILED"; forget_tries
else
  rc=$?
  # Exit 1 = the release did not start and was rolled back: set aside at once.
  # 3 = it did not complete (the install step, the network): tried again, less
  # and less often. 5 = this machine's disk (full, or a folder it cannot
  # write): tried again the same way, never set aside for it. 2 = refused
  # (local changes), 4 = an upgrade was running, or the channel changed while
  # this waited: routine, the tick ends 0 and counts nothing (ninth and
  # thirteenth reviews). A full disk (5) ends 1, so the unit shows
  # it failed, but counts only towards the wait, never against the release.
  # But a pin upgrade.sh took back is not tried again: the channel is, next tick.
  if [ "$rc" = 4 ]; then
    echo "Another upgrade of $DIR is running, or this machine's channel changed while this tick waited (above): it leaves $TARGET to the next tick."
    exit 0
  elif [ "$rc" != 1 ] && [ -n "$PINNED" ] && [ "$(remembered)" != "$PINNED" ]; then
    echo "Upgrading to $PINNED did not complete (see above), so this machine is no longer pinned to it."
  elif [ "$rc" = 1 ]; then
    set_aside "$TARGET" "Upgrading to $TARGET failed and was rolled back." "It will not be retried; the channel's next release will be."
  elif [ "$rc" = 3 ] && [ $((T_COUNT + 1 - T_DISK)) -ge "$MAX_TRIES" ]; then
    set_aside "$TARGET" "Upgrading to $TARGET did not complete $MAX_TRIES times in a row." "It will not be retried; the channel's next release will be (or run: hatchabot upgrade $CHANNEL)."
  elif [ "$rc" = 3 ]; then
    note_try 0
    echo "Upgrading to $TARGET did not complete (see above); it will be tried again later ($((T_COUNT + 1 - T_DISK)) of $MAX_TRIES)."
  elif [ "$rc" = 5 ]; then
    note_try 1
    echo "Upgrading to $TARGET could not start on this machine's disk (see above); it will be tried again later. This does not count against $TARGET."
  else
    echo "Upgrading to $TARGET did not complete (see above); it will be tried again."
  fi
  exit 1
fi
