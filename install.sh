#!/usr/bin/env bash
# Hatchabot one-line installer.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/hatchabot/hatchabot/main/install.sh)"
#
# What it does: checks git, Docker and Node 22+ (offers to install the missing
# ones where that is safe), clones the release on your channel (stable unless you say otherwise) into ~/hatchabot (or
# updates an existing clone), then runs scripts/setup-host.sh — which writes
# .env, pulls the runtime image, installs the background service and links the
# `hatchabot` command. Re-running is safe. Set HATCHABOT_DIR to install elsewhere.
set -euo pipefail
DIR="${HATCHABOT_DIR:-$HOME/hatchabot}"
# Which release to install — a channel, or an exact version:
#   stable  (the default) what new users get; moved deliberately, after a soak
#   beta    the next stable, for people willing to try it first
#   latest  the newest tagged release, whatever it is
#   v2.30.3 exactly that release
# Set it with HATCHABOT_CHANNEL=beta, or as the first argument. An install
# remembers its channel, so re-running this upgrades along the same one.
CHANNEL_FILE="$HOME/.config/hatchabot/channel"
CHANNEL="${HATCHABOT_CHANNEL:-${1:-}}"
if [ -z "$CHANNEL" ] && [ -f "$CHANNEL_FILE" ]; then CHANNEL="$(tr -d '[:space:]' < "$CHANNEL_FILE")"; fi
CHANNEL="${CHANNEL:-stable}"
REPO="${HATCHABOT_REPO:-https://github.com/hatchabot/hatchabot.git}"
OS="$(uname -s)"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
# The setup script asks for a password: give it a terminal even when this
# script arrived through a pipe.
[ -t 0 ] || { [ -r /dev/tty ] && exec </dev/tty; } || true
# The question goes to the terminal explicitly. It used to be `read -p … 2>/dev/null`:
# read -p writes its prompt to stderr, so the question was thrown away and a
# fresh Linux machine sat silently at "2/4 Docker" waiting for an answer nobody
# could see (found by a clean-VM install, 2026-09-23). No terminal: "no".
ask() {
  local a=n
  # Unattended (a provisioner installing for a tenant, a test bed): HATCHABOT_YES=1 says yes to every offer.
  if [ "${HATCHABOT_YES:-}" = 1 ]; then return 0; fi
  if { : >/dev/tty; } 2>/dev/null; then
    printf '%s [y/N] ' "$1" >/dev/tty
    read -r a </dev/tty || a=n
  fi
  [ "$(printf %s "$a" | tr "[:upper:]" "[:lower:]")" = y ]
}

say "Hatchabot installer — $OS $(uname -m)"
[ "$(id -u)" != 0 ] || die "Run this as your own user, not root (no sudo): Hatchabot installs as a user service."
[ "$OS" = Linux ] || [ "$OS" = Darwin ] || die "Linux or macOS only (found $OS). On Windows, use WSL2 with Docker Desktop."

say "1/4 git"
if ! have git; then
  if [ "$OS" = Darwin ]; then echo "Installing the Xcode command-line tools (provides git)…"; xcode-select --install 2>/dev/null || true; die "Re-run this installer once the tools have finished installing."; fi
  have apt-get && ask "git is missing. Install it with apt?" && sudo apt-get install -y git || die "Install git, then re-run."
fi
echo "   git $(git --version | awk '{print $3}')"

say "2/4 Docker"
if ! have docker; then
  if [ "$OS" = Darwin ]; then die "Install Docker Desktop for Mac (https://docs.docker.com/desktop/setup/install/mac-install/), start it, then re-run."; fi
  if ask "Docker is missing. Install Docker Engine with the official script (get.docker.com)?"; then
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker "${USER:-$(id -un)}" || true
    die "Docker installed. Log out and back in (so your user is in the docker group), then re-run this installer."
  else die "Install Docker (https://docs.docker.com/engine/install/), then re-run."; fi
fi
if ! docker info >/dev/null 2>&1; then
  if [ "$OS" = Darwin ]; then
    # Installed but not running is the usual state after a reboot: start it
    # rather than send the user off to do it. The first launch after install
    # can stop at Docker's terms screen, which only the user can accept.
    open -a Docker 2>/dev/null || die "Docker Desktop isn't running, and it could not be started. Start it, then re-run."
    printf '   starting Docker Desktop'
    for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; printf .; sleep 2; done; echo
    docker info >/dev/null 2>&1 || die "Docker Desktop did not finish starting. If it is showing a window (terms, sign-in), answer it, wait for the whale in the menu bar to stop moving, then re-run."
  fi
fi
if ! docker info >/dev/null 2>&1; then
  if id -nG "${USER:-$(id -un)}" | grep -qw docker; then die "Docker isn't reachable. Is the daemon running? (sudo systemctl start docker)"; fi
  if ask "Your user isn't in the docker group. Add it now?"; then sudo usermod -aG docker "${USER:-$(id -un)}"; die "Added. Log out and back in, then re-run this installer."; fi
  die "Run: sudo usermod -aG docker $(id -un) — then log out and back in."
fi
echo "   docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) ($(docker version --format '{{.Server.Arch}}' 2>/dev/null))"

say "3/4 Node.js 22+ and build tools"
node_ok() { have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; }
if ! node_ok; then
  if [ "$OS" = Darwin ] && have brew; then ask "Node 22+ is missing. Install it with Homebrew?" && brew install node@22 && brew link --overwrite node@22 || die "Install Node 22+ (https://nodejs.org), then re-run."
  elif have apt-get && ask "Node 22+ is missing. Install Node 22 from NodeSource (apt)?"; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
  else die "Install Node 22+ (https://nodejs.org or https://github.com/Schniz/fnm), then re-run."; fi
  node_ok || die "Node is still not 22+ on PATH. Open a new shell and re-run."
fi
echo "   node $(node --version)"
# The database driver (better-sqlite3 13) compiles on install — it no longer
# downloads a prebuilt binary — so it needs make, a C++ compiler and Python.
# Every developer machine has them; a fresh Ubuntu does not, and npm failed
# with "not found: make" (found by a clean-VM install, 2026-09-23). A Mac has
# them with the Xcode command-line tools, which git already required.
if [ "$OS" = Linux ] && ! { have make && { have g++ || have c++; } && have python3; }; then
  if have apt-get && ask "Build tools are missing (make, a C++ compiler, Python) — Hatchabot's database driver is compiled when it installs. Install them with apt (build-essential)?"; then
    sudo apt-get install -y build-essential python3
  else
    die "Install make, g++ and python3, then re-run. (Debian/Ubuntu: sudo apt-get install -y build-essential python3 · Fedora: sudo dnf install -y make gcc-c++ python3)"
  fi
fi

say "4/4 Hatchabot → $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --tags --force --quiet origin
else
  git clone --quiet "$REPO" "$DIR"
fi
# `sed -n 1p`, not `head -1`: head closes the pipe after one line, git tag gets
# SIGPIPE writing the other few hundred, and under pipefail this whole script
# died with exit 141 — silently, at "4/4" — on any re-run (2026-09-25).
newest() { git -C "$DIR" tag -l 'v[0-9]*' --sort=-v:refname | grep -vE -- '-(rc|beta|alpha)' | sed -n 1p; }
case "$CHANNEL" in
  latest) LATEST="$(newest)" ;;
  v[0-9]*)
    git -C "$DIR" rev-parse -q --verify "refs/tags/$CHANNEL" >/dev/null || die "There is no release $CHANNEL."
    LATEST="$CHANNEL" ;;
  stable|beta)
    # Named releases live in channels.json on main, so promoting one is a
    # one-line commit and never a new tag.
    LATEST="$(git -C "$DIR" show origin/main:channels.json 2>/dev/null | sed -nE "s/.*\"$CHANNEL\"[[:space:]]*:[[:space:]]*\"(v[^\"]+)\".*/\1/p" | sed -n 1p)"
    if [ -z "$LATEST" ]; then
      echo "   (no $CHANNEL release is named yet — using the newest)"
      LATEST="$(newest)"
    fi ;;
  *) die "Unknown channel '$CHANNEL' — use stable, beta, latest, or a version like v2.30.3." ;;
esac
[ -n "$LATEST" ] || die "No release tags found in $REPO."
if [ "${HATCHABOT_DRY_RUN:-0}" = "1" ]; then
  echo "   channel $CHANNEL → release $LATEST  (dry run: nothing checked out or installed)"
  exit 0
fi
# Is Hatchabot already installed, from somewhere else? Running setup-host.sh
# here would point the service at THIS directory — replacing a working install
# with one that runs from a different checkout. That is how a production box
# ends up serving a development tree. Checked BEFORE the checkout below moves
# anything: it used to leave a development clone detached at the stable tag.
UNIT="$HOME/.config/systemd/user/hatchabot.service"
if [ -f "$UNIT" ]; then
  INSTALLED="$(sed -n 's/^WorkingDirectory=//p' "$UNIT" | sed -n 1p)"
  INSTALLED="${INSTALLED/#\%h/$HOME}"
  if [ -n "$INSTALLED" ] && [ "$INSTALLED" != "$DIR" ]; then
    die "Hatchabot is already installed here, running from:
    $INSTALLED
Installing into $DIR would repoint the service at it and leave the other one dark.

  Upgrade the existing install:   hatchabot upgrade   (or: cd $INSTALLED && git fetch --tags --force && git checkout $LATEST && ./scripts/restart.sh)
  Try a release on a clean machine: scripts/clean-install-test.sh (a throwaway VM)
  Remove the existing one first:  cd $INSTALLED && ./scripts/uninstall.sh"
  fi
fi

CUR="$(git -C "$DIR" describe --tags --exact-match 2>/dev/null || echo none)"
if [ "$CUR" != "$LATEST" ]; then
  if [ -n "$(git -C "$DIR" status --porcelain)" ]; then
    echo
    echo "   These files differ from the release:"
    git -C "$DIR" status --porcelain | sed 's/^/     /'
    echo
    die "$DIR has local changes, so it is still on $CUR and will NOT be upgraded to $LATEST.
  Keep them:     cd $DIR && git stash
  Discard them:  cd $DIR && git checkout -- .
Then re-run this installer. (Your .env, data/ and backups are untouched either way.)"
  fi
  git -C "$DIR" checkout --quiet "$LATEST"
fi
echo "   channel $CHANNEL → release $LATEST"

mkdir -p "$(dirname "$CHANNEL_FILE")"
# Remember it OUTSIDE the clone: a file inside would be an untracked change,
# and the next upgrade's "local changes?" check would refuse to move. A pinned
# version is remembered too — re-running stays pinned until told otherwise.
printf '%s\n' "$CHANNEL" > "$CHANNEL_FILE"

cd "$DIR"
exec ./scripts/setup-host.sh
