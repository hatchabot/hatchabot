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

valid() { case "${1:-}" in stable|beta|latest) return 0 ;; *) return 1 ;; esac; }

if [ "${1:-}" = --install ]; then
  valid "${2:-}" || { echo "Usage: $0 --install stable|beta|latest"; exit 1; }
  command -v systemctl >/dev/null 2>&1 || { echo "This needs systemd (Linux). On a Mac, run 'hatchabot upgrade' from time to time."; exit 1; }
  mkdir -p "$UNITS"
  cat > "$UNITS/$NAME.service" <<UNIT
[Unit]
Description=Hatchabot: follow the $2 release channel

[Service]
Type=oneshot
# The user manager's PATH does not include a node installed by nvm or Homebrew.
Environment=PATH=$(dirname "$(command -v node)"):$(dirname "$(command -v docker || echo /usr/bin/docker)"):/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env bash "$DIR/scripts/follow-channel.sh" $2
UNIT
  cat > "$UNITS/$NAME.timer" <<UNIT
[Unit]
Description=Hatchabot: check the $2 channel every 10 minutes

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

# What the channel names now — the same resolution as upgrade.sh, needed here
# only to remember a failure and not retry it every ten minutes.
# (A bundle install has no clone: release-target.sh asks GitHub instead.)
TARGET="$("$DIR/scripts/release-target.sh" "$CHANNEL" 2>/dev/null)" || exit 0
[ -n "$TARGET" ] || exit 0
# Pinned by hand to a version (hatchabot upgrade vX.Y.Z): leave it there.
case "$(tr -d '[:space:]' < "$HOME/.config/hatchabot/channel" 2>/dev/null)" in v[0-9]*) exit 0 ;; esac
if [ -f BUNDLE.json ] && [ ! -d .git ]; then CUR="$(sed -nE 's/.*"tag":"([^"]+)".*/\1/p' BUNDLE.json)"
else CUR="$(git describe --tags --exact-match 2>/dev/null || true)"; fi
[ "$CUR" = "$TARGET" ] && exit 0
mkdir -p "$STATE"
FAILED="$STATE/follow-channel-failed"
if [ "$(cat "$FAILED" 2>/dev/null)" = "$TARGET" ]; then exit 0; fi
# A release whose install keeps failing (exit 3: npm ci against a lockfile
# that does not match, a driver that will not compile) is not tried every ten
# minutes for ever: after each failure in a row the wait doubles (10 min,
# 20, 40 … a day at most), and after MAX_TRIES it is set aside like a
# release that did not start (review, 2026-10-09). "<release> <failures> <epoch>".
TRIES="$STATE/follow-channel-tries"; MAX_TRIES=8
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
if HATCHABOT_UPGRADE_BY_TIMER=1 bash "$DIR/scripts/upgrade.sh" "$CHANNEL"; then
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
