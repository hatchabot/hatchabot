#!/usr/bin/env bash
# Restart the AgentClaw control plane, whichever service manager runs it.
#   ./scripts/restart.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# npm may live off the non-interactive PATH (macOS launchd/ssh quirk).
command -v npm >/dev/null 2>&1 || PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Self-heal "pulled but never installed": a dependency added upstream crashes
# the service on import with nothing on screen but a dead port (the Mac peer
# sat broken exactly this way, 2026-09-05). Install when the lockfile no
# longer matches the last installed one; the stamp lives in node_modules so a
# wiped tree also reinstalls.
STAMP="node_modules/.agentclaw-lock-stamp"
LOCK_HASH="$(cksum package-lock.json 2>/dev/null | cut -d' ' -f1 || true)"
if [ -n "$LOCK_HASH" ] && [ "$(cat "$STAMP" 2>/dev/null || true)" != "$LOCK_HASH" ]; then
  echo "Dependencies changed since the last install — running npm install…"
  npm install --no-audit --no-fund
  echo "$LOCK_HASH" > "$STAMP"
fi

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
