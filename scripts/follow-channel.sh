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
  cat > "$UNITS/$NAME.service" <<UNIT
[Unit]
Description=Hatchabot: follow the release channel chosen last (installed for $2)

[Service]
Type=oneshot
Environment="PATH=$(printf '%s' "$UNIT_PATH" | sed -e 's/[\\"]/\\&/g' -e 's/%/%%/g')"
ExecStart=/usr/bin/env bash "$(printf '%s' "$DIR" | sed -e 's/[\\"]/\\&/g' -e 's/%/%%/g' -e 's/\$/$$/g')/scripts/follow-channel.sh" $2
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
REMEMBERED=""
if [ -f "$CHANNEL_FILE" ]; then REMEMBERED="$(tr -d '[:space:]' < "$CHANNEL_FILE")"
elif [ -f "$USER_CHANNEL_FILE" ]; then REMEMBERED="$(tr -d '[:space:]' < "$USER_CHANNEL_FILE")"; fi
# Pinned by hand to a version (hatchabot upgrade vX.Y.Z): leave it there.
case "$REMEMBERED" in v[0-9]*) exit 0 ;; esac
if valid "$REMEMBERED"; then CHANNEL="$REMEMBERED"; fi

# What the channel names now — the same resolution as upgrade.sh, needed here
# only to remember a failure and not retry it every ten minutes.
# (A bundle install has no clone: release-target.sh asks GitHub instead.)
TARGET="$("$DIR/scripts/release-target.sh" "$CHANNEL" 2>/dev/null)" || exit 0
[ -n "$TARGET" ] || exit 0
if [ -f BUNDLE.json ] && [ ! -d .git ]; then CUR="$(sed -nE 's/.*"tag":"([^"]+)".*/\1/p' BUNDLE.json)"
else CUR="$(git describe --tags --exact-match 2>/dev/null || true)"; fi
# This install's own records, keyed on its path as the upgrade lock is: one
# file for every install of the user's let a release that failed on one set
# it aside on another, which then stayed behind (audit #034). The records
# from before (unkeyed) are taken over by the first install that looks.
KEY="$(printf %s "$DIR" | cksum | cut -d' ' -f1)"
# A bundle swap that was cut off (.swapping) may have the new BUNDLE.json in
# already, and a git install's upgrade killed part-way (its record beside the
# lock) the new release checked out with half its dependencies: upgrade.sh
# repairs both, so it runs (HB-0049, HB-0266).
[ "$CUR" = "$TARGET" ] && [ ! -f .swapping ] && [ ! -f "$STATE/upgrade-$KEY.from" ] && exit 0
mkdir -p "$STATE"
FAILED="$STATE/follow-channel-failed-$KEY"
TRIES="$STATE/follow-channel-tries-$KEY"; MAX_TRIES=8
for r in failed tries; do
  [ ! -f "$STATE/follow-channel-$r" ] || [ -e "$STATE/follow-channel-$r-$KEY" ] || mv -f "$STATE/follow-channel-$r" "$STATE/follow-channel-$r-$KEY" || true
done
# A release set aside stays aside, but not with a cut swap or a killed
# upgrade to repair: upgrade.sh puts the earlier release back first, then
# tries this one once more.
if [ ! -f .swapping ] && [ ! -f "$STATE/upgrade-$KEY.from" ] && [ "$(cat "$FAILED" 2>/dev/null)" = "$TARGET" ]; then exit 0; fi
# A release whose install keeps failing (exit 3: npm ci against a lockfile
# that does not match, a driver that will not compile) is not tried every ten
# minutes for ever: after each failure in a row the wait doubles (10 min,
# 20, 40 … a day at most), and after MAX_TRIES it is set aside like a
# release that did not start (review, 2026-10-09). "<release> <failures> <epoch>".
T_TARGET=""; T_COUNT=0; T_LAST=0
{ read -r T_TARGET T_COUNT T_LAST < "$TRIES"; } 2>/dev/null || true
case "${T_COUNT:-}${T_LAST:-}" in ''|*[!0-9]*) T_COUNT=0; T_LAST=0 ;; esac
if [ "$T_TARGET" = "$TARGET" ] && [ "$T_COUNT" -gt 0 ]; then
  WAIT=$(( 10 * (1 << (T_COUNT - 1)) - 5 ))   # minutes, less 5 for the timer's own jitter: 5, 15, 35 …
  [ "$WAIT" -le 1440 ] || WAIT=1440
  [ $(( $(date +%s) - T_LAST )) -ge $(( WAIT * 60 )) ] || exit 0
else
  T_COUNT=0
fi

# upgrade.sh runs from its own copy (it checks out a different release of
# itself), so calling it from here is safe. HATCHABOT_UPGRADE_BY_TIMER: it
# leaves the remembered channel alone — someone may have switched it by hand.
# HATCHABOT_UPGRADE_TARGET: the release resolved above, not the channel again —
# a channel that moved in between had the release upgrade.sh tried fail, this
# one set aside, and the next tick try the failed one again (audit #042).
if HATCHABOT_UPGRADE_BY_TIMER=1 HATCHABOT_UPGRADE_TARGET="$TARGET" bash "$DIR/scripts/upgrade.sh" "$CHANNEL"; then
  rm -f "$FAILED" "$TRIES"
else
  rc=$?
  # Exit 1 = the release did not start and was rolled back: set aside at once.
  # 3 = it did not complete (the install step, the network): tried again, less
  # and less often. 2 = refused (local changes), 4 = an upgrade was running.
  if [ "$rc" = 1 ]; then
    echo "$TARGET" > "$FAILED"; rm -f "$TRIES"
    echo "Upgrading to $TARGET failed and was rolled back. It will not be retried; the channel's next release will be."
  elif [ "$rc" = 3 ] && [ $((T_COUNT + 1)) -ge "$MAX_TRIES" ]; then
    echo "$TARGET" > "$FAILED"; rm -f "$TRIES"
    echo "Upgrading to $TARGET did not complete $MAX_TRIES times in a row. It will not be retried; the channel's next release will be (or run: hatchabot upgrade $CHANNEL)."
  elif [ "$rc" = 3 ]; then
    echo "$TARGET $((T_COUNT + 1)) $(date +%s)" > "$TRIES"
    echo "Upgrading to $TARGET did not complete (see above); it will be tried again later ($((T_COUNT + 1)) of $MAX_TRIES)."
  else
    echo "Upgrading to $TARGET did not complete (see above); it will be tried again."
  fi
  exit 1
fi
