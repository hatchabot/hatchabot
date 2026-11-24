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

[ -f package-lock.json ] || exit 0  # no lockfile: nothing to reason about

# One run at a time per install folder (HB-1067): a restart and a setup run
# together both found the stamp old and both ran `npm ci`, which empties
# node_modules, and one restarted the service while the other was still
# putting it back. Everything from here (reading the stamps, the install, the
# driver, writing the stamps) is under one lock, so a run that waited reads
# the stamps the other wrote and has nothing to do. The lock is a folder
# (mkdir is atomic everywhere; macOS has no flock) in this user's state
# folder, keyed on the install's path, as upgrade.sh's is. Its holder is
# written in it (pid and start time: a pid reused since is not the holder);
# one whose holder is gone is a leftover, cleared under a second lock and
# judged again once that is held, so two runs cannot both clear it.
LOCKS="${XDG_STATE_HOME:-$HOME/.local/state}/hatchabot"
DEPS_LOCK="$LOCKS/deps-$(printf %s "$PWD" | cksum | cut -d' ' -f1).lock.d"
# In UTC: read in each reader's own zone, a holder started with TZ set (or with
# none, as the timer's upgrade) was taken for gone by a waiter in another zone
# (review of HB-1067).
proc_start() { LC_ALL=C TZ=UTC0 ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//'; }
ME="$$"; MY_START="$(proc_start $$)"; [ -z "$MY_START" ] || ME="$$ $MY_START"
holder_gone() {
  local owner pid
  owner="$(cat "$DEPS_LOCK/owner" 2>/dev/null)" || owner=""
  # None written: a run that has only just made it, unless it is old.
  if [ -z "$owner" ]; then [ -n "$(find "$DEPS_LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; return; fi
  pid="${owner%% *}"
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  if [ "$owner" = "$pid" ]; then ! kill -0 "$pid" 2>/dev/null; else [ "$owner" != "$pid $(proc_start "$pid")" ]; fi
}
release_lock() { [ -z "$DEPS_LOCK" ] || [ "$(cat "$DEPS_LOCK/owner" 2>/dev/null)" != "$ME" ] || rm -rf "$DEPS_LOCK"; return 0; }
mkdir -p "$LOCKS" 2>/dev/null || true
# How many one-second tries the lock is waited for: half an hour (tests make it a few).
DEPS_WAIT="${HATCHABOT_DEPS_WAIT_SECS:-1800}"; case "$DEPS_WAIT" in ''|*[!0-9]*) DEPS_WAIT=1800 ;; esac
WAITED=0
until mkdir "$DEPS_LOCK" 2>/dev/null; do
  if [ ! -d "$DEPS_LOCK" ]; then
    # Neither made nor there (no room, no permission): no lock to be had, and
    # the install goes on as it did before there was one.
    echo "Could not take the dependency lock $DEPS_LOCK — going on without it." >&2
    DEPS_LOCK=""; break
  fi
  # A takeover a kill cut short is cleared once it is a minute old.
  find "$DEPS_LOCK.takeover" -maxdepth 0 -mmin +1 -exec rmdir {} \; 2>/dev/null || true
  if holder_gone && mkdir "$DEPS_LOCK.takeover" 2>/dev/null; then
    if holder_gone; then rm -rf "$DEPS_LOCK"; fi
    rmdir "$DEPS_LOCK.takeover"
    continue
  fi
  if [ "$WAITED" = 0 ]; then
    HOLDER="$(cat "$DEPS_LOCK/owner" 2>/dev/null || true)"
    echo "Waiting for another install of the dependencies in $PWD${HOLDER:+ (pid ${HOLDER%% *})} to finish…"
  fi
  WAITED=$((WAITED + 1))
  # Half an hour is longer than any install and compile takes: one that long has stopped.
  [ "$WAITED" -lt "$DEPS_WAIT" ] || { echo "Another install of the dependencies in $PWD has held $DEPS_LOCK for half an hour, so nothing was installed. If no npm is running there, remove it: rm -r \"$DEPS_LOCK\"" >&2; exit 1; }
  sleep 1
done
if [ -n "$DEPS_LOCK" ]; then
  trap release_lock EXIT
  # Stopped by a signal, the lock goes too (the EXIT trap, through exit).
  trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP
  if ! { printf '%s\n' "$ME" > "$DEPS_LOCK/owner.$$" && mv -f "$DEPS_LOCK/owner.$$" "$DEPS_LOCK/owner"; } 2>/dev/null; then
    # A holder it could not write (a full disk) would read as a run just
    # begun for ten minutes: let go, and go on as before there was one.
    rm -rf "$DEPS_LOCK"; DEPS_LOCK=""
  fi
fi

STAMP="node_modules/.hatchabot-lock-stamp"
LOCK_HASH="$(cksum package-lock.json 2>/dev/null | cut -d' ' -f1 || true)"
[ -n "$LOCK_HASH" ] || exit 0
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
