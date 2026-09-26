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
git fetch --tags --force --quiet origin
newest() { git tag -l 'v[0-9]*' --sort=-v:refname | grep -vE -- '-(rc|beta|alpha)' | sed -n 1p; }
case "$CHANNEL" in
  latest) TARGET="$(newest)" ;;
  *) TARGET="$(git show origin/main:channels.json 2>/dev/null | sed -nE "s/.*\"$CHANNEL\"[[:space:]]*:[[:space:]]*\"(v[^\"]+)\".*/\1/p" | sed -n 1p)"
     [ -n "$TARGET" ] || TARGET="$(newest)" ;;
esac
[ -n "$TARGET" ] || exit 0
CUR="$(git describe --tags --exact-match 2>/dev/null || true)"
[ "$CUR" = "$TARGET" ] && exit 0
mkdir -p "$STATE"
FAILED="$STATE/follow-channel-failed"
if [ "$(cat "$FAILED" 2>/dev/null)" = "$TARGET" ]; then exit 0; fi

# upgrade.sh runs from its own copy (it checks out a different release of
# itself), so calling it from here is safe.
if bash "$DIR/scripts/upgrade.sh" "$CHANNEL"; then
  rm -f "$FAILED"
else
  rc=$?
  # Exit 2 = refused (local changes), 3 = the install step failed: transient,
  # tried again next time. Exit 1 = the release did not start.
  if [ "$rc" = 1 ]; then
    echo "$TARGET" > "$FAILED"
    echo "Upgrading to $TARGET failed and was rolled back. It will not be retried; the channel's next release will be."
  else
    echo "Upgrading to $TARGET did not complete (see above); it will be tried again."
  fi
  exit 1
fi
