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
# The health probe is loopback on purpose — TLS terminates in front (e.g.
# tailscale serve), so localhost:PORT is the listener, not the front door.
# Report the PUBLIC https URL when configured; the loopback one is a detail.
PUBLIC_URL="$( { sed -n 's/^AGENTCLAW_PUBLIC_URL=//p' "$HOME/.config/agentclaw/env" 2>/dev/null; sed -n 's/^AGENTCLAW_PUBLIC_URL=//p' .env 2>/dev/null; } \
  | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']$//' | tail -n1 || true)"
# 60s, not 30: the DGX control plane takes ~40s to serve, and the old cap
# printed a scary failure for a boot that was going fine.
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://localhost:${PORT}/healthz"; then
    if [ -n "$PUBLIC_URL" ]; then
      echo "AgentClaw is up — ${PUBLIC_URL}  (listener: http://localhost:${PORT})"
    else
      echo "AgentClaw is up on http://localhost:${PORT}"
      echo "Tip: set AGENTCLAW_PUBLIC_URL in ~/.config/agentclaw/env to your https address — invites and Google OAuth redirect URIs use it."
    fi
    exit 0
  fi
  sleep 1
done
echo "Service was restarted but isn't answering on port ${PORT} yet."
echo "Logs: tail -30 data/server.log   (mac)   journalctl --user -u agentclaw -n 30   (linux)"
exit 1
