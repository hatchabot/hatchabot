#!/usr/bin/env bash
# Restart the AgentClaw control plane, whichever service manager runs it.
#   ./scripts/restart.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(uname -s)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.agentclaw.control-plane.plist"
  launchctl unload -w "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
else
  systemctl --user restart agentclaw
fi

# Wait for it to answer, so "restarted" means "actually serving".
# .env values may be quoted or carry an inline comment — take the bare value.
PORT="$(sed -n 's/^PORT=//p' .env 2>/dev/null \
  | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']$//' \
  | tail -n1 || true)"
PORT="${PORT:-8080}"
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "http://localhost:${PORT}/healthz"; then
    echo "AgentClaw is up on http://localhost:${PORT}"
    exit 0
  fi
  sleep 1
done
echo "Service was restarted but isn't answering on port ${PORT} yet."
echo "Logs: tail -30 data/server.log   (mac)   journalctl --user -u agentclaw -n 30   (linux)"
exit 1
