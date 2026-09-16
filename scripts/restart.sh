#!/usr/bin/env bash
# Restart the Hatchabot control plane, whichever service manager runs it.
#   ./scripts/restart.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# npm may live off the non-interactive PATH (macOS launchd/ssh quirk).
command -v npm >/dev/null 2>&1 || PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Self-heal "pulled but never installed": a dependency added upstream crashes
# the service on import with nothing on screen but a dead port (the Mac peer
# sat broken exactly this way, 2026-09-05).
./scripts/ensure-deps.sh --quiet

if [ "$(uname -s)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.hatchabot.control-plane.plist"
  launchctl unload -w "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
else
  systemctl --user restart hatchabot
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
PUBLIC_URL="$( { sed -n 's/^HATCHABOT_PUBLIC_URL=//p' "$HOME/.config/hatchabot/env" 2>/dev/null; sed -n 's/^HATCHABOT_PUBLIC_URL=//p' .env 2>/dev/null; } \
  | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']$//' | tail -n1 || true)"
# 60s, not 30: the DGX control plane takes ~40s to serve, and the old cap
# printed a scary failure for a boot that was going fine.
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://localhost:${PORT}/healthz"; then
    if [ -n "$PUBLIC_URL" ]; then
      echo "Hatchabot is up — ${PUBLIC_URL}  (listener: http://localhost:${PORT})"
    else
      echo "Hatchabot is up on http://localhost:${PORT}"
      echo "Tip: set HATCHABOT_PUBLIC_URL in ~/.config/hatchabot/env to your https address — invites and Google OAuth redirect URIs use it."
    fi
    exit 0
  fi
  sleep 1
done
echo "Service was restarted but isn't answering on port ${PORT}."
# Print the reason rather than pointing at it: a crash-on-boot (a bad .env
# line, a duplicate route, a missing dependency) is ALWAYS in these lines, and
# "here are the logs" sends people to restart again instead of reading them.
echo
if [ -s data/server.log ]; then
  echo "Last lines of data/server.log:"
  echo "----------------------------------------------------------------"
  tail -n 20 data/server.log
  echo "----------------------------------------------------------------"
elif command -v journalctl >/dev/null 2>&1; then
  echo "Last lines from the service log:"
  echo "----------------------------------------------------------------"
  journalctl --user -u hatchabot -n 20 --no-pager 2>/dev/null || true
  echo "----------------------------------------------------------------"
fi
echo
echo "If that names a version already fixed upstream, check you are on the"
echo "latest release:  hatchabot doctor   (it reports the tag and any local"
echo "changes that stop the installer upgrading)."
exit 1
