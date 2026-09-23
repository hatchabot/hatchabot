#!/usr/bin/env bash
# Keep THIS machine's production install on the newest release tag.
#
#   scripts/follow-latest.sh             # deploy the newest tag if prod is behind
#   scripts/follow-latest.sh --install   # run it every 10 minutes (systemd --user timer)
#   scripts/follow-latest.sh --uninstall
#
# Tagging makes a release `latest`; new installs still take `stable`, which moves
# only with promote.sh. This is for the machine you develop on: it runs every
# release first, so a bad one surfaces here before anyone else can install it.
#
# Deploys go through deploy-release.sh — health check and automatic rollback.
# A tag that failed is remembered and not retried; the next tag clears it.
set -euo pipefail
PROD="${HATCHABOT_PROD_DIR:-$HOME/hatchabot-prod}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/hatchabot"
UNITS="$HOME/.config/systemd/user"
NAME=hatchabot-follow-latest

if [ "${1:-}" = --install ]; then
  mkdir -p "$UNITS"
  cat > "$UNITS/$NAME.service" <<EOF
[Unit]
Description=Hatchabot: deploy the newest release tag to this machine

[Service]
Type=oneshot
Environment=HATCHABOT_PROD_DIR=$PROD
Environment=PATH=$(dirname "$(command -v node)"):$(dirname "$(command -v docker || echo /usr/bin/docker)"):/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env bash "$PROD/scripts/follow-latest.sh"
EOF
  cat > "$UNITS/$NAME.timer" <<EOF
[Unit]
Description=Hatchabot: check for a newer release every 10 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$NAME.timer"
  echo "This machine now follows the newest release. Logs: journalctl --user -u $NAME"
  echo "Stop with: $0 --uninstall"
  exit 0
fi
if [ "${1:-}" = --uninstall ]; then
  systemctl --user disable --now "$NAME.timer" 2>/dev/null || true
  rm -f "$UNITS/$NAME.service" "$UNITS/$NAME.timer"
  systemctl --user daemon-reload
  echo "Stopped following the newest release. Deploy by hand with deploy-release.sh."
  exit 0
fi

# A deploy checks out a new tag in $PROD, replacing this very file while bash is
# still reading it. Run from a private copy.
if [ -z "${FOLLOW_LATEST_COPY:-}" ]; then
  tmp="$(mktemp)"; cp "$0" "$tmp"
  FOLLOW_LATEST_COPY="$tmp" exec bash "$tmp" "$@"
fi
trap 'rm -f "$FOLLOW_LATEST_COPY"' EXIT

[ -d "$PROD/.git" ] || { echo "No production checkout at $PROD."; exit 1; }
mkdir -p "$STATE"
git -C "$PROD" fetch --tags --force --quiet origin
NEWEST="$(git -C "$PROD" tag -l 'v[0-9]*' --sort=-v:refname | grep -vE -- '-(rc|beta|alpha)' | head -1)"
[ -n "$NEWEST" ] || exit 0
CUR="$(git -C "$PROD" describe --tags --exact-match 2>/dev/null || true)"
[ "$CUR" = "$NEWEST" ] && exit 0
# Only ever forward: a checkout that is ahead (a hand deploy of a newer tag) stays.
vernewer() { printf '%s\n%s\n' "$1" "$2" | sed 's/-/~/' | sort -V | tail -1 | sed 's/~/-/'; }
if [ -n "$CUR" ] && [ "$(vernewer "$CUR" "$NEWEST")" = "$CUR" ]; then exit 0; fi
if [ "$(cat "$STATE/follow-latest-failed" 2>/dev/null)" = "$NEWEST" ]; then exit 0; fi

# The deploy script as the NEW release ships it, from a copy for the same reason.
deploy="$(mktemp)"
git -C "$PROD" show "$NEWEST:scripts/deploy-release.sh" > "$deploy"
echo "Following latest: ${CUR:-untagged} → $NEWEST"
if HATCHABOT_PROD_DIR="$PROD" bash "$deploy" "$NEWEST"; then
  rm -f "$STATE/follow-latest-failed" "$deploy"
else
  rc=$?
  rm -f "$deploy"
  # Exit 2 = refused (a stray file in prod), 3 = the install step failed: both
  # transient, tried again next time. Exit 1 = the release did not start.
  if [ "$rc" = 1 ]; then
    echo "$NEWEST" > "$STATE/follow-latest-failed"
    echo "Deploying $NEWEST failed and was rolled back. It will not be retried; the next tag will be."
  else
    echo "Deploying $NEWEST did not complete (see above); it will be tried again."
  fi
  exit 1
fi
