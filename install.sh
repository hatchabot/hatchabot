#!/usr/bin/env bash
# Hatchabot one-line installer.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/hatchabot/hatchabot/main/install.sh)"
#
# What it does: checks git, Docker and Node 22+ (offers to install the missing
# ones where that is safe), clones the LATEST RELEASE into ~/hatchabot (or
# updates an existing clone), then runs scripts/setup-host.sh — which writes
# .env, pulls the runtime image, installs the background service and links the
# `hatchabot` command. Re-running is safe. Set HATCHABOT_DIR to install elsewhere.
set -euo pipefail
DIR="${HATCHABOT_DIR:-$HOME/hatchabot}"
REPO="${HATCHABOT_REPO:-https://github.com/hatchabot/hatchabot.git}"
OS="$(uname -s)"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
# The setup script asks for a password: give it a terminal even when this
# script arrived through a pipe.
[ -t 0 ] || { [ -r /dev/tty ] && exec </dev/tty; } || true
ask() { local a; read -r -p "$1 [y/N] " a </dev/tty 2>/dev/null || a=n; [ "${a,,}" = y ]; }

say "Hatchabot installer — $OS $(uname -m)"
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
    sudo usermod -aG docker "$USER" || true
    die "Docker installed. Log out and back in (so your user is in the docker group), then re-run this installer."
  else die "Install Docker (https://docs.docker.com/engine/install/), then re-run."; fi
fi
if ! docker info >/dev/null 2>&1; then
  if [ "$OS" = Darwin ]; then die "Docker Desktop isn't running. Start it, then re-run."; fi
  if id -nG "$USER" | grep -qw docker; then die "Docker isn't reachable. Is the daemon running? (sudo systemctl start docker)"; fi
  if ask "Your user isn't in the docker group. Add it now?"; then sudo usermod -aG docker "$USER"; die "Added. Log out and back in, then re-run this installer."; fi
  die "Run: sudo usermod -aG docker $USER — then log out and back in."
fi
echo "   docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) ($(docker version --format '{{.Server.Arch}}' 2>/dev/null))"

say "3/4 Node.js 22+"
node_ok() { have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; }
if ! node_ok; then
  if [ "$OS" = Darwin ] && have brew; then ask "Node 22+ is missing. Install it with Homebrew?" && brew install node@22 && brew link --overwrite node@22 || die "Install Node 22+ (https://nodejs.org), then re-run."
  elif have apt-get && ask "Node 22+ is missing. Install Node 22 from NodeSource (apt)?"; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
  else die "Install Node 22+ (https://nodejs.org or https://github.com/Schniz/fnm), then re-run."; fi
  node_ok || die "Node is still not 22+ on PATH. Open a new shell and re-run."
fi
echo "   node $(node --version)"

say "4/4 Hatchabot → $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --tags --quiet origin
else
  git clone --quiet "$REPO" "$DIR"
fi
LATEST="$(git -C "$DIR" describe --tags "$(git -C "$DIR" rev-list --tags --max-count=1)")"
CUR="$(git -C "$DIR" describe --tags --exact-match 2>/dev/null || echo none)"
if [ "$CUR" != "$LATEST" ]; then
  [ -z "$(git -C "$DIR" status --porcelain)" ] || die "$DIR has local changes — commit or stash them, then re-run."
  git -C "$DIR" checkout --quiet "$LATEST"
fi
echo "   release $LATEST"
cd "$DIR"
exec ./scripts/setup-host.sh
