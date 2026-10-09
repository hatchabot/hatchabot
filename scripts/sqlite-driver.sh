#!/usr/bin/env bash
# Make sure the database driver (better-sqlite3) loads on THIS machine.
#
#   scripts/sqlite-driver.sh            check; compile here only if it does not load
#   scripts/sqlite-driver.sh --compile  always compile here (the release bundle)
#
# better-sqlite3 13 ships prebuilt binaries and always loads the one for the
# platform when it is there — with no fallback. Its Linux binaries need glibc
# 2.38, so on Ubuntu 22.04 or Debian 12 Hatchabot could not open its database
# at all (found 2026-10-06 building the release bundle). Here the prebuilt one
# is removed and the driver is compiled against this machine's C library with
# npm's own node-gyp (make, a C++ compiler and Python, which the native install
# already requires).
set -euo pipefail
[ -x "$(dirname "$0")/../.node/bin/node" ] && PATH="$(cd "$(dirname "$0")/.." && pwd)/.node/bin:$PATH" && export PATH  # a bundle install's own Node (install.sh)
cd "${HATCHABOT_APP_DIR:-$(dirname "$0")/..}"
loads() { node -e 'const D = require("better-sqlite3"); const db = new D(":memory:"); db.exec("SELECT 1"); db.close()' 2>/dev/null; }

if [ "${1:-}" != --compile ] && loads; then exit 0; fi
[ "${1:-}" = --compile ] || echo "The database driver's prebuilt binary does not load here (it needs a newer C library) — compiling it for this machine…"

DRIVER=node_modules/better-sqlite3
[ -d "$DRIVER" ] || { echo "better-sqlite3 is not installed (run npm ci first)" >&2; exit 1; }
GYP="$(npm root -g 2>/dev/null)/npm/node_modules/node-gyp/bin/node-gyp.js"
[ -f "$GYP" ] || GYP="$(dirname "$(command -v npm)")/../lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
[ -f "$GYP" ] || { echo "npm's node-gyp was not found: cannot compile the database driver" >&2; exit 1; }
# With the prebuilt binaries gone, the driver loads the one compiled here
# (build/Release), and binding.gyp's own "is there a prebuild?" check says no.
rm -rf "$DRIVER/prebuilds"
# A log of its own (mktemp): a fixed name in a shared /tmp could be made first
# by another user — a symlink to one of our files, or a file we cannot write —
# and the build then wrote through it or failed (review, 2026-10-09).
LOG="$(mktemp "${TMPDIR:-/tmp}/hatchabot-sqlite-build.XXXXXX")"
( cd "$DRIVER" && node "$GYP" rebuild --release >/dev/null 2>"$LOG" ) \
  || { echo "Compiling the database driver failed — see $LOG (make, g++ and python3 are needed)" >&2; exit 1; }
rm -f "$LOG"
loads || { echo "The database driver was compiled but still does not load" >&2; exit 1; }
echo "Database driver compiled for this machine."
