#!/usr/bin/env bash
# Installs Hatchabot as a user-level systemd service.
#
#   ./scripts/install-service.sh
#
# Requires a .env in the repo root containing at least HATCHABOT_SECRET_KEY.
# After install: systemctl --user {status|restart|stop} hatchabot
#                journalctl --user -u hatchabot -f
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env found. Create one first (chmod 600) containing:"
  echo "  HATCHABOT_SECRET_KEY=<your passphrase>"
  echo "  PORT=8080"
  exit 1
fi

# The unit reads it via EnvironmentFile and it holds the secret key —
# tighten it regardless of how it was created.
chmod 600 .env

# systemd user managers start with a minimal PATH — nvm-installed node and a
# docker outside /usr/bin are invisible to them, so bake the real locations
# into both units (the macOS launchd branch of setup-host.sh does the same,
# for the same reason).
# Resolve node/docker explicitly and fail loudly if missing — `dirname ""`
# would otherwise silently bake "." into the unit's PATH.
NODE_BIN="$(command -v node)" || { echo "node not found on PATH — install Node 22+ first." >&2; exit 1; }
DOCKER_BIN="$(command -v docker)" || { echo "docker not found on PATH — install Docker first." >&2; exit 1; }
SERVICE_PATH="$(dirname "$NODE_BIN"):$(dirname "$DOCKER_BIN"):/usr/local/bin:/usr/bin:/bin"

mkdir -p ~/.config/systemd/user
# Substitute the real repo location — the units used to hardcode ~/hatchabot,
# so any other clone path failed silently at boot. Escape sed-replacement
# metacharacters (& | \) so a clone path containing them can't corrupt the
# generated unit.
sed_escape() { printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'; }
DIR_ESC="$(sed_escape "$(pwd)")"
PATH_ESC="$(sed_escape "$SERVICE_PATH")"
sed -e "s|__HATCHABOT_DIR__|$DIR_ESC|g" -e "s|__HATCHABOT_PATH__|$PATH_ESC|g" \
  deploy/hatchabot.service > ~/.config/systemd/user/hatchabot.service
sed -e "s|__HATCHABOT_DIR__|$DIR_ESC|g" -e "s|__HATCHABOT_PATH__|$PATH_ESC|g" \
  deploy/hatchabot-backup.service > ~/.config/systemd/user/hatchabot-backup.service
cp deploy/hatchabot-backup.timer ~/.config/systemd/user/hatchabot-backup.timer
systemctl --user daemon-reload
# enable --now alone would leave an already-running service on the old unit —
# restart so a re-run (e.g. after moving the repo) actually takes effect.
systemctl --user enable hatchabot
systemctl --user restart hatchabot
systemctl --user enable hatchabot-backup.timer
systemctl --user restart hatchabot-backup.timer

# Lingering lets user services start at boot instead of at first login.
if loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
  echo "Lingering already enabled — service starts at boot."
else
  if loginctl enable-linger "$USER" 2>/dev/null; then
    echo "Lingering enabled — service starts at boot."
  else
    echo "⚠ Could not enable lingering (needs admin). Run once:"
    echo "    sudo loginctl enable-linger $USER"
    echo "  Until then the service starts at your first login instead of at boot."
  fi
fi

# The service runs under the user's systemd manager, whose groups were fixed
# when it started. If that was before the user joined the docker group — the
# installer adds it, and "log out and back in" within seconds, or `newgrp`,
# leaves the old manager running, which lingering then keeps for good — the
# service is denied Docker while a login shell has it: every agent fails with
# "Could not create the agent volume" and nothing says why (clean-VM install,
# 2026-09-23). Restarting the manager fixes it; a login session is not touched.
DOCKER_GID="$(getent group docker 2>/dev/null | cut -d: -f3)"
MANAGER="$(pgrep -u "$USER" -x systemd 2>/dev/null | head -1)"
if [ -n "$DOCKER_GID" ] && [ -n "$MANAGER" ] && id -nG "$USER" | tr ' ' '\n' | grep -qx docker \
   && ! grep '^Groups:' "/proc/$MANAGER/status" 2>/dev/null | tr ' \t' '\n\n' | grep -qx "$DOCKER_GID"; then
  echo
  echo "⚠ Your background services started before you joined the docker group, so"
  echo "  Hatchabot cannot use Docker yet (your terminal can — that is why it looks fine)."
  a=n
  if { : >/dev/tty; } 2>/dev/null; then
    printf '  Restart your user services now? (sudo systemctl restart user@%s — your login stays) [y/N] ' "$(id -u)" >/dev/tty
    read -r a </dev/tty || a=n
  fi
  if [ "$(printf %s "$a" | tr '[:upper:]' '[:lower:]')" = y ] && sudo systemctl restart "user@$(id -u).service"; then
    sleep 2
    systemctl --user start hatchabot hatchabot-backup.timer 2>/dev/null || true
    echo "  Restarted — Hatchabot can use Docker now."
  else
    echo "  Fix it later with:  sudo systemctl restart user@$(id -u)   (or reboot)"
  fi
fi

systemctl --user status hatchabot --no-pager | head -5
