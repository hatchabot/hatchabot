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
[ -x "$(dirname "$0")/../.node/bin/node" ] && PATH="$(cd "$(dirname "$0")/.." && pwd)/.node/bin:$PATH" && export PATH  # a bundle install's own Node (install.sh)
cd "$(dirname "$0")/.."

# npm may live off the non-interactive PATH (macOS launchd/ssh quirk).
command -v npm >/dev/null 2>&1 || PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

STAMP="node_modules/.hatchabot-lock-stamp"
LOCK_HASH="$(cksum package-lock.json 2>/dev/null | cut -d' ' -f1 || true)"
[ -n "$LOCK_HASH" ] || exit 0  # no lockfile: nothing to reason about
# The Node the database driver was last checked under, by its native-module
# ABI: the same lockfile under a new Node major (brew, nvm, NodeSource) kept a
# driver compiled for the old one, which Node refuses (NODE_MODULE_VERSION),
# while this said "up to date" (audit #045). Its own file beside the stamp, so
# an older release reading the stamp still finds just the lockfile's sum.
ABI_STAMP="node_modules/.hatchabot-node-abi"
ABI="$(node -p process.versions.modules 2>/dev/null || true)"

if [ "$(cat "$STAMP" 2>/dev/null || true)" = "$LOCK_HASH" ] && [ -d node_modules ]; then
  if [ -n "$ABI" ] && [ "$(cat "$ABI_STAMP" 2>/dev/null || true)" != "$ABI" ]; then
    # Checks it loads; compiles it for this Node only when it does not.
    ./scripts/sqlite-driver.sh
    echo "$ABI" > "$ABI_STAMP"
  fi
  [ "${1:-}" = "--quiet" ] || echo "Dependencies are up to date."
  exit 0
fi

echo "Installing dependencies (the lockfile changed since the last install)…"
npm ci --no-audit --no-fund
# The driver's prebuilt binary needs glibc 2.38: compile it here when it does not load.
./scripts/sqlite-driver.sh
echo "$LOCK_HASH" > "$STAMP"
[ -z "$ABI" ] || echo "$ABI" > "$ABI_STAMP"
