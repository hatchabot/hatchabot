#!/usr/bin/env bash
# Hatchabot one-line installer.
#
#   curl -fsSL https://hatchabot.com/install.sh | bash
#
# One prerequisite: a container runtime (Docker), which it offers to install.
# On Ubuntu/Debian (x64 or arm64, glibc 2.35 or newer) and Apple-silicon Macs it
# downloads the release's prebuilt bundle — Hatchabot with its own Node and
# database driver inside — so git, Node and a compiler are not needed
# (docs/install-bundle.md). Anywhere else, or when a release has no bundle or it
# fails its self-check, it falls back to the native install: git clone, Node 22
# and build tools. HATCHABOT_NATIVE=1 forces that. Then scripts/setup-host.sh
# writes .env, pulls the agent runtime image, installs the background service,
# links the `hatchabot` command, and prints the link (and a QR code) to open.
# Re-running is safe: it upgrades along the same channel. HATCHABOT_DIR installs
# elsewhere (default ~/hatchabot).
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
SLUG="${HATCHABOT_SLUG:-hatchabot/hatchabot}"
REPO="${HATCHABOT_REPO:-https://github.com/$SLUG.git}"
RAW="https://raw.githubusercontent.com/$SLUG"
# Where the bundles are (the release's assets); a test bed may serve its own.
BUNDLES="${HATCHABOT_BUNDLE_BASE:-https://github.com/$SLUG/releases/download}"
OS="$(uname -s)"
ME="${USER:-$(id -un)}"
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
in_docker_group() { getent group docker 2>/dev/null | cut -d: -f4 | tr ',' '\n' | grep -qx "$ME"; }

say "Hatchabot installer — $OS $(uname -m)"
[ "$(id -u)" != 0 ] || die "Run this as your own user, not root (no sudo): Hatchabot installs as a user service."
[ "$OS" = Linux ] || [ "$OS" = Darwin ] || die "Linux or macOS only (found $OS). On Windows, use WSL2 with Docker Desktop."

# ---- 1/3 Docker: the one prerequisite -------------------------------------------
say "1/3 Docker"
# Docker works for this user only through `sg docker` (just added to the group;
# no log-out needed: scripts/with-docker.sh does the same for the service).
VIA_SG=0
dk() { if [ "$VIA_SG" = 1 ]; then sg docker -c "docker $(printf '%q ' "$@")"; else docker "$@"; fi; }
if ! have docker; then
  if [ "$OS" = Darwin ]; then
    if have brew && ask "Docker is missing. Install Docker Desktop with Homebrew (brew install --cask docker)?"; then
      brew install --cask docker || die "Homebrew could not install Docker Desktop — install it from https://docs.docker.com/desktop/setup/install/mac-install/, then re-run."
    else
      die "Install Docker Desktop for Mac (https://docs.docker.com/desktop/setup/install/mac-install/), start it, then re-run."
    fi
  elif ask "Docker is missing. Install Docker Engine with the official script (get.docker.com)?"; then
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker "$ME" || true
  else die "Install Docker (https://docs.docker.com/engine/install/), then re-run."; fi
fi
if ! docker info >/dev/null 2>&1 && [ "$OS" = Darwin ]; then
  # Installed but not running is the usual state after a reboot: start it
  # rather than send the user off to do it. The first launch after install
  # can stop at Docker's terms screen, which only the user can accept.
  open -a Docker 2>/dev/null || die "Docker Desktop isn't running, and it could not be started. Start it, then re-run."
  printf '   starting Docker Desktop'
  for _ in $(seq 1 90); do docker info >/dev/null 2>&1 && break; printf .; sleep 2; done; echo
  docker info >/dev/null 2>&1 || die "Docker Desktop did not finish starting. If it is showing a window (terms, sign-in), answer it, wait for the whale in the menu bar to stop moving, then re-run."
fi
if [ "$OS" = Linux ] && ! docker info >/dev/null 2>&1; then
  if ! in_docker_group; then
    ask "Your user isn't in the docker group. Add it now?" && sudo usermod -aG docker "$ME" \
      || die "Run: sudo usermod -aG docker $ME — then re-run this installer."
  fi
  # In the group (just now, or since this login): no log-out — sg gives it now.
  if have sg && sg docker -c "docker info" >/dev/null 2>&1; then VIA_SG=1
  else die "Docker isn't reachable. Is the daemon running? (sudo systemctl start docker)"; fi
fi
echo "   docker $(dk version --format '{{.Server.Version}}' 2>/dev/null) ($(dk version --format '{{.Server.Arch}}' 2>/dev/null))"

# ---- which release ---------------------------------------------------------------
# Named releases live in channels.json on main, so promoting one is a one-line
# commit and never a new tag.
newest_release() { curl -fsSL "https://api.github.com/repos/$SLUG/releases/latest" 2>/dev/null | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"(v[^"]+)".*/\1/p' | sed -n 1p; }
case "$CHANNEL" in
  v[0-9]*) TAG="$CHANNEL" ;;
  latest) TAG="$(newest_release)" ;;
  stable|beta)
    TAG="$(curl -fsSL "$RAW/main/channels.json" 2>/dev/null | sed -nE "s/.*\"$CHANNEL\"[[:space:]]*:[[:space:]]*\"(v[^\"]+)\".*/\1/p" | sed -n 1p)"
    [ -n "$TAG" ] || { echo "   (no $CHANNEL release is named yet — using the newest)"; TAG="$(newest_release)"; } ;;
  *) die "Unknown channel '$CHANNEL' — use stable, beta, latest, or a version like v2.30.3." ;;
esac
[ -n "${TAG:-}" ] || die "Could not find which release to install (no network to github.com?)."

# Which bundle fits this machine: Ubuntu/Debian-like Linux with glibc 2.35+, or an Apple-silicon Mac.
PLATFORM=""
case "$OS-$(uname -m)" in
  Linux-x86_64) PLATFORM=linux-x64 ;;
  Linux-aarch64|Linux-arm64) PLATFORM=linux-arm64 ;;
  Darwin-arm64) PLATFORM=darwin-arm64 ;;
esac
if [ "$OS" = Linux ] && [ -n "$PLATFORM" ]; then
  GLIBC="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')"
  # musl (Alpine) has no GNU_LIBC_VERSION; older glibc cannot load the bundle's driver.
  if [ -z "$GLIBC" ] || [ "$(printf '%s\n2.35\n' "$GLIBC" | sort -V | sed -n 1p)" != 2.35 ]; then PLATFORM=""; fi
fi
MODE=native
if [ -d "$DIR/.git" ]; then MODE=native-existing
elif [ -f "$DIR/BUNDLE.json" ]; then MODE=bundle-existing
elif [ "${HATCHABOT_NATIVE:-0}" != 1 ] && [ -n "$PLATFORM" ]; then MODE=bundle
fi
if [ "${HATCHABOT_DRY_RUN:-0}" = "1" ]; then
  echo "   channel $CHANNEL → release $TAG · ${PLATFORM:-no bundle for this machine} · $MODE  (dry run: nothing installed)"
  exit 0
fi

# Is Hatchabot already installed, from somewhere else? Setting up here would
# point the service at THIS directory — replacing a working install with one
# that runs from a different place. That is how a production box ends up
# serving a development tree. Checked BEFORE anything below moves.
UNIT="$HOME/.config/systemd/user/hatchabot.service"
INSTALLED=""
if [ -f "$UNIT" ]; then
  INSTALLED="$(sed -n 's/^WorkingDirectory=//p' "$UNIT" | sed -n 1p)"
  INSTALLED="${INSTALLED/#\%h/$HOME}"
elif [ "$OS" = Darwin ]; then
  # launchd has no WorkingDirectory: setup-host.sh bakes `cd "<dir>"` into the
  # job's command (read back the same way uninstall.sh does). Linux-only, this
  # guard let a Mac's one-line install repoint a working install at a fresh
  # clone with an empty database (night review, 2026-09-28).
  for p in com.hatchabot.control-plane com.agentclaw.control-plane; do
    PL="$HOME/Library/LaunchAgents/$p.plist"
    [ -f "$PL" ] || continue
    INSTALLED="$(sed -n 's/.*cd &quot;\([^&]*\)&quot;.*/\1/p;s/.*cd "\([^"]*\)".*/\1/p' "$PL" | sed -n 1p)"
    [ -n "$INSTALLED" ] && break
  done
fi
if [ -n "$INSTALLED" ] && [ "$INSTALLED" != "$DIR" ]; then
  die "Hatchabot is already installed here, running from:
    $INSTALLED
Installing into $DIR would repoint the service at it and leave the other one dark.

  Upgrade the existing install:   hatchabot upgrade
  Try a release on a clean machine: scripts/clean-install-test.sh (a throwaway VM)
  Remove the existing one first:  cd $INSTALLED && ./scripts/uninstall.sh"
fi

# ---- 2/3 Hatchabot ----------------------------------------------------------------
say "2/3 Hatchabot $TAG → $DIR"
sha256() { if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
# The prebuilt bundle: download, check its hash, unpack, and run its own
# self-check (its Node opens a database with its driver) before it goes in.
# Any failure returns non-zero, and the native install takes over.
install_bundle() {
  local name="hatchabot-$TAG-$PLATFORM.tar.gz" tmp want
  tmp="$(mktemp -d)"
  echo "   downloading $name…"
  curl -fsSL --retry 3 -o "$tmp/$name" "$BUNDLES/$TAG/$name" || { echo "   (no bundle for $TAG on $PLATFORM)"; rm -rf "$tmp"; return 1; }
  want="$(curl -fsSL --retry 3 "$BUNDLES/$TAG/$name.sha256" 2>/dev/null | cut -d' ' -f1)"
  [ -n "$want" ] && [ "$want" = "$(sha256 "$tmp/$name")" ] || { echo "   (the bundle's checksum does not match — not using it)"; rm -rf "$tmp"; return 1; }
  tar -xzf "$tmp/$name" -C "$tmp" || { rm -rf "$tmp"; return 1; }
  ( cd "$tmp/hatchabot" && ./.node/bin/node -e 'new (require("better-sqlite3"))(":memory:").exec("SELECT 1")' ) >/dev/null 2>&1 \
    || { echo "   (the bundle does not run on this machine — falling back)"; rm -rf "$tmp"; return 1; }
  mkdir -p "$(dirname "$DIR")"
  mv "$tmp/hatchabot" "$DIR"
  rm -rf "$tmp"
  echo "   unpacked: Hatchabot with its own Node $("$DIR/.node/bin/node" --version) — nothing to compile"
}
# The native install: git, Node 22+ and build tools; a clone at the release.
install_native() {
  if ! have git; then
    if [ "$OS" = Darwin ]; then echo "Installing the Xcode command-line tools (provides git)…"; xcode-select --install 2>/dev/null || true; die "Re-run this installer once the tools have finished installing."; fi
    have apt-get && ask "git is missing. Install it with apt?" && sudo apt-get install -y git || die "Install git, then re-run."
  fi
  node_ok() { have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; }
  if ! node_ok; then
    if [ "$OS" = Darwin ] && have brew; then ask "Node 22+ is missing. Install it with Homebrew?" && brew install node@22 && brew link --overwrite node@22 || die "Install Node 22+ (https://nodejs.org), then re-run."
    elif have apt-get && ask "Node 22+ is missing. Install Node 22 from NodeSource (apt)?"; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
    else die "Install Node 22+ (https://nodejs.org or https://github.com/Schniz/fnm), then re-run."; fi
    node_ok || die "Node is still not 22+ on PATH. Open a new shell and re-run."
  fi
  echo "   node $(node --version)"
  # The database driver may need compiling here (scripts/sqlite-driver.sh), so
  # make, a C++ compiler and Python — a fresh Ubuntu has none of them (found by
  # a clean-VM install, 2026-09-23). A Mac has them with the Xcode tools.
  if [ "$OS" = Linux ] && ! { have make && { have g++ || have c++; } && have python3; }; then
    if have apt-get && ask "Build tools are missing (make, a C++ compiler, Python) — Hatchabot's database driver may be compiled when it installs. Install them with apt (build-essential)?"; then
      sudo apt-get install -y build-essential python3
    else
      die "Install make, g++ and python3, then re-run. (Debian/Ubuntu: sudo apt-get install -y build-essential python3 · Fedora: sudo dnf install -y make gcc-c++ python3)"
    fi
  fi
  if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch --tags --force --quiet origin
  else git clone --quiet "$REPO" "$DIR"; fi
  git -C "$DIR" rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "There is no release $TAG."
  local cur; cur="$(git -C "$DIR" describe --tags --exact-match 2>/dev/null || echo none)"
  if [ "$cur" != "$TAG" ]; then
    if [ -n "$(git -C "$DIR" status --porcelain)" ]; then
      echo; echo "   These files differ from the release:"; git -C "$DIR" status --porcelain | sed 's/^/     /'; echo
      die "$DIR has local changes, so it is still on $cur and will NOT be upgraded to $TAG.
  Keep them:     cd $DIR && git stash
  Discard them:  cd $DIR && git checkout -- .
Then re-run this installer. (Your .env, data/ and backups are untouched either way.)"
    fi
    git -C "$DIR" checkout --quiet "$TAG"
  fi
}

case "$MODE" in
  bundle-existing)
    # A bundle install already here: an upgrade, with its own rollback.
    mkdir -p "$(dirname "$CHANNEL_FILE")"; printf '%s\n' "$CHANNEL" > "$CHANNEL_FILE"
    cd "$DIR"
    exec ./scripts/with-docker.sh ./scripts/upgrade.sh "$CHANNEL" ;;
  native-existing) install_native ;;
  bundle)
    if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then die "$DIR already exists and is not a Hatchabot install — move it aside (or set HATCHABOT_DIR), then re-run."; fi
    rmdir "$DIR" 2>/dev/null || true
    install_bundle || { MODE=native; echo "   using the native install instead"; install_native; } ;;
  native) install_native ;;
esac
echo "   channel $CHANNEL → release $TAG ($( [ -f "$DIR/BUNDLE.json" ] && echo bundle || echo native ))"

mkdir -p "$(dirname "$CHANNEL_FILE")"
# Remember it OUTSIDE the install: a file inside would be an untracked change,
# and the next upgrade's "local changes?" check would refuse to move. A pinned
# version is remembered too — re-running stays pinned until told otherwise.
printf '%s\n' "$CHANNEL" > "$CHANNEL_FILE"

# ---- 3/3 set up ---------------------------------------------------------------------
say "3/3 Setting up"
cd "$DIR"
# A bundle carries its own Node: everything below (and the service) uses it.
[ -x .node/bin/node ] && export PATH="$DIR/.node/bin:$PATH"
# A release from before the docker-group wrapper has no with-docker.sh.
if [ -x scripts/with-docker.sh ]; then exec ./scripts/with-docker.sh ./scripts/setup-host.sh; fi
if [ "$VIA_SG" = 1 ]; then exec sg docker -c "PATH=$(printf '%q' "$PATH") ./scripts/setup-host.sh"; fi
exec ./scripts/setup-host.sh
