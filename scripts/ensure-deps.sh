#!/usr/bin/env bash
# Install dependencies when — and only when — the lockfile has moved since the
# last install.
#
# Both the installer and restart.sh need this, and when they each did it their
# own way you got two full installs back to back: setup-host.sh ran `npm ci`
# (which deletes node_modules, and with it the stamp), then restart.sh found no
# stamp and installed everything again. One helper, one stamp, one install.
#
# The stamp lives inside node_modules on purpose: a wiped or partial tree then
# reinstalls, which is the failure this whole mechanism exists to catch (a
# dependency added upstream crashes the service on import with nothing on
# screen but a dead port).
set -euo pipefail
cd "$(dirname "$0")/.."

# npm may live off the non-interactive PATH (macOS launchd/ssh quirk).
command -v npm >/dev/null 2>&1 || PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

STAMP="node_modules/.hatchabot-lock-stamp"
LOCK_HASH="$(cksum package-lock.json 2>/dev/null | cut -d' ' -f1 || true)"
[ -n "$LOCK_HASH" ] || exit 0  # no lockfile: nothing to reason about

if [ "$(cat "$STAMP" 2>/dev/null || true)" = "$LOCK_HASH" ] && [ -d node_modules ]; then
  [ "${1:-}" = "--quiet" ] || echo "Dependencies are up to date."
  exit 0
fi

echo "Installing dependencies (the lockfile changed since the last install)…"
npm ci --no-audit --no-fund
echo "$LOCK_HASH" > "$STAMP"
