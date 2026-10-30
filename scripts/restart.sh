#!/usr/bin/env bash
# Restart the Hatchabot control plane, whichever service manager runs it.
#   ./scripts/restart.sh
set -euo pipefail
[ -x "$(dirname "$0")/../.node/bin/node" ] && PATH="$(cd "$(dirname "$0")/.." && pwd)/.node/bin:$PATH" && export PATH  # a bundle install's own Node (install.sh)
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
# .env (the unit's EnvironmentFile) is what the service runs with; its values
# may be quoted or carry an inline comment — take the bare value, last wins.
# systemd also takes spaces around the = (PORT = 9137): read only as PORT=,
# that was probed on 8080 for a minute and reported down (audit, 2026-10-29).
# The Mac's launchd job sources .env with bash (launchd-plist.sh), where only
# NAME=value sets it: PORT = 9137 is a command, PORT= 9137 sets nothing.
if [ "$(uname -s)" = "Darwin" ]; then
  envlines() { sed -n -e "/^[[:space:]]*$1=[[:space:]][[:space:]]*[^#[:space:]]/d" -e "s/^[[:space:]]*$1=//p" .env; }
else
  envlines() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env; }
fi
envval() { { envlines "$1" 2>/dev/null || true; } \
  | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']$//' \
  | tail -n1; }
PORT="$(envval PORT)"
PORT="${PORT:-8080}"
# The probe asks the listener itself, as the service is configured: https
# when it serves TLS natively (HATCHABOT_TLS_CERT), at its HATCHABOT_BIND
# address when that is one host. Probing plain http://localhost failed a
# healthy native-TLS or LAN-bound listener, and an upgrade rolled back for it.
# -k: this asks whether it is serving, not whether the certificate names
# 127.0.0.1 (it names the machine's real address; doctor checks that one).
SCHEME=http; [ -n "$(envval HATCHABOT_TLS_CERT)" ] && SCHEME=https
BIND="$(envval HATCHABOT_BIND)"
case "$BIND" in
  ""|0.0.0.0|::|"[::]"|localhost|127.0.0.1) PROBE_HOST=localhost ;;
  \[*) PROBE_HOST="$BIND" ;;
  *:*) PROBE_HOST="[$BIND]" ;;   # an IPv6 address goes in brackets in a URL
  *) PROBE_HOST="$BIND" ;;
esac
LISTENER="${SCHEME}://${PROBE_HOST}:${PORT}"
# TLS usually terminates in front (e.g. tailscale serve), so the listener is
# not the front door: report the PUBLIC https URL when configured.
PUBLIC_URL="$( { sed -n 's/^HATCHABOT_PUBLIC_URL=//p' "$HOME/.config/hatchabot/env" 2>/dev/null; sed -n 's/^[[:space:]]*HATCHABOT_PUBLIC_URL[[:space:]]*=[[:space:]]*//p' .env 2>/dev/null; } \
  | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']$//' | tail -n1 || true)"
# 60s, not 30: the DGX control plane takes ~40s to serve, and the old cap
# printed a scary failure for a boot that was going fine.
for _ in $(seq 1 60); do
  if curl -sfk -o /dev/null "${LISTENER}/healthz"; then
    if [ -n "$PUBLIC_URL" ]; then
      echo "Hatchabot is up — ${PUBLIC_URL}  (listener: ${LISTENER})"
    else
      echo "Hatchabot is up on ${LISTENER}"
      echo "Tip: set HATCHABOT_PUBLIC_URL in ~/.config/hatchabot/env to your https address — invites and Google OAuth redirect URIs use it."
    fi
    exit 0
  fi
  sleep 1
done
echo "Service was restarted but isn't answering at ${LISTENER}."
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
