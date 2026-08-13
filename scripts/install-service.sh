#!/usr/bin/env bash
# Installs AgentClaw as a user-level systemd service.
#
#   ./scripts/install-service.sh
#
# Requires a .env in the repo root containing at least AGENTCLAW_SECRET_KEY.
# After install: systemctl --user {status|restart|stop} agentclaw
#                journalctl --user -u agentclaw -f
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env found. Create one first (chmod 600) containing:"
  echo "  AGENTCLAW_SECRET_KEY=<your passphrase>"
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
# Substitute the real repo location — the units used to hardcode ~/agentclaw,
# so any other clone path failed silently at boot. Escape sed-replacement
# metacharacters (& | \) so a clone path containing them can't corrupt the
# generated unit.
sed_escape() { printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'; }
DIR_ESC="$(sed_escape "$(pwd)")"
PATH_ESC="$(sed_escape "$SERVICE_PATH")"
sed -e "s|__AGENTCLAW_DIR__|$DIR_ESC|g" -e "s|__AGENTCLAW_PATH__|$PATH_ESC|g" \
  deploy/agentclaw.service > ~/.config/systemd/user/agentclaw.service
sed -e "s|__AGENTCLAW_DIR__|$DIR_ESC|g" -e "s|__AGENTCLAW_PATH__|$PATH_ESC|g" \
  deploy/agentclaw-backup.service > ~/.config/systemd/user/agentclaw-backup.service
cp deploy/agentclaw-backup.timer ~/.config/systemd/user/agentclaw-backup.timer
systemctl --user daemon-reload
# enable --now alone would leave an already-running service on the old unit —
# restart so a re-run (e.g. after moving the repo) actually takes effect.
systemctl --user enable agentclaw
systemctl --user restart agentclaw
systemctl --user enable agentclaw-backup.timer
systemctl --user restart agentclaw-backup.timer

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

systemctl --user status agentclaw --no-pager | head -5
