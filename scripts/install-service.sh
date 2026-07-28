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

mkdir -p ~/.config/systemd/user
cp deploy/agentclaw.service ~/.config/systemd/user/agentclaw.service
systemctl --user daemon-reload
systemctl --user enable --now agentclaw

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
