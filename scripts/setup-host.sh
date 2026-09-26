#!/usr/bin/env bash
# One-command setup for a fresh Hatchabot host (e.g. the desktop you're
# importing an agent onto). Safe to re-run: every step is idempotent.
#
#   git clone https://github.com/hatchabot/hatchabot.git hatchabot
#   cd hatchabot && ./scripts/setup-host.sh
#
# What it does: checks prerequisites, installs dependencies, writes a .env
# (random secret key + how people sign in), pulls the runtime image (builds only if that fails),
# installs the systemd user service, and links the `hatchabot` CLI.
set -euo pipefail
umask 077   # .env and ~/.config/hatchabot/env hold secrets: never created wider than 0600
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Checking prerequisites…"
command -v docker >/dev/null || { echo "docker is required — install Docker Engine first."; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker is installed but not usable by this user (try: sudo usermod -aG docker \$USER, then re-login)."; exit 1; }
command -v node >/dev/null || { echo "node is required — install Node.js 22+."; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || { echo "Node 22+ required (found $(node --version))."; exit 1; }

say "Installing dependencies…"
./scripts/ensure-deps.sh

if [ ! -f .env ]; then
  say "Creating .env…"
  # Family accounts are the default: a home box is usually shared, and one
  # password means one owner of everything and a terminal trip to reset it.
  # Unattended (a provisioner installing for a tenant, a test bed): answer
  # with HATCHABOT_SETUP_SIGNIN=accounts|password, HATCHABOT_SETUP_PASSWORD,
  # HATCHABOT_SETUP_PORT, and HATCHABOT_SETUP_ENV (extra .env lines, e.g.
  # DOCKER_HOST and the port bases of a tenant on a shared host).
  case "${HATCHABOT_SETUP_SIGNIN:-}" in
    accounts) SIGNIN=1 ;;
    password) SIGNIN=2 ;;
    "")
      echo "How will people sign in?"
      echo "  1) An account for each person — their own agents, and a forgotten"
      echo "     password is a link you send them  (recommended)"
      echo "  2) One shared password"
      read -r -p "Choose [1]: " SIGNIN
      SIGNIN="${SIGNIN:-1}" ;;
    *) echo "HATCHABOT_SETUP_SIGNIN must be accounts or password."; exit 1 ;;
  esac
  PW=""
  if [ "$SIGNIN" = "2" ]; then
    if [ -n "${HATCHABOT_SETUP_PASSWORD:-}" ]; then PW="$HATCHABOT_SETUP_PASSWORD"; else read -r -s -p "Choose an app password (what you'll type to open the web app): " PW; echo; fi
    [ -n "$PW" ] || { echo "Password cannot be empty."; exit 1; }
    # systemd's EnvironmentFile and the shell read a quoted apostrophe
    # differently, so a password holding one never matched on Linux.
    case "$PW" in *"'"*) echo "Please choose a password without an apostrophe (')."; exit 1 ;; esac
  fi
  {
    echo "HATCHABOT_SECRET_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
    if [ "$SIGNIN" = "2" ]; then
      # Two parsers read this line: the macOS launchd wrapper sources .env as
      # shell, and systemd's EnvironmentFile parses it itself. Single quotes are
      # the one quoting both understand (systemd strips them, shell honours
      # them) — %q's backslash escapes would reach systemd literally.
      printf "HATCHABOT_PASSWORD='%s'\n" "$(printf '%s' "$PW" | sed "s/'/'\\\\''/g")"
    else
      # No account yet: the first visit FROM THIS MACHINE creates yours. From
      # anywhere else it needs the setup code the server prints when it starts.
      echo "HATCHABOT_AUTH=accounts"
    fi
    echo "PORT=${HATCHABOT_SETUP_PORT:-8080}"
    echo "# Set when reachable beyond localhost, e.g. via Tailscale — used in invite links:"
    echo "# HATCHABOT_PUBLIC_URL=http://<this-machine>.<tailnet>.ts.net:8080"
    if [ -n "${HATCHABOT_SETUP_ENV:-}" ]; then printf '%s\n' "$HATCHABOT_SETUP_ENV"; fi
  } > .env
  chmod 600 .env
else
  say ".env already exists — keeping it."
fi

if docker image inspect hatchabot-runtime:latest >/dev/null 2>&1; then
  # An existing install may have promoted a NEWER image to :latest — a default
  # build here would silently demote it (learned the hard way). An OLDER one
  # (a reinstall on a box that kept its images) is brought up to this
  # release's default, the way an upgrade does (2026-09-25).
  WANT="$(sed -n 's/^ARG OPENCLAW_VERSION=//p' docker/Dockerfile.runtime | sed -n 1p)"
  HAVE="$(docker image inspect hatchabot-runtime:latest --format '{{ index .Config.Labels "org.agentclaw.openclaw-version" }}' 2>/dev/null || true)"
  if [ -n "$WANT" ] && [ -n "$HAVE" ] && [ "$HAVE" != "$WANT" ] && [ "$(printf '%s\n%s\n' "$HAVE" "$WANT" | sed 's/-/~/' | sort -V | sed -n 1p)" = "$(printf '%s' "$HAVE" | sed 's/-/~/')" ]; then
    say "Runtime image here carries OpenClaw $HAVE; this release's default is $WANT — fetching it…"
    ./scripts/build-runtime-image.sh || echo "⚠ Could not fetch the $WANT image now — run ./scripts/build-runtime-image.sh later, or Settings → Images."
  else
    say "Runtime image already present — keeping the existing :latest."
  fi
else
  say "Building the agent runtime image (a few minutes on first run)…"
  ./scripts/build-runtime-image.sh
fi

if [ "$(uname -s)" = "Darwin" ]; then
  say "Installing the launchd service (macOS)…"
  REPO="$(pwd)"
  # launchd's default PATH is /usr/bin:/bin — node (Homebrew/nvm) and docker
  # (Docker Desktop: /usr/local/bin) live elsewhere, so bake their real
  # locations into the service environment.
  NODE_DIR="$(dirname "$(command -v node)")"
  DOCKER_DIR="$(dirname "$(command -v docker)")"
  PLIST="$HOME/Library/LaunchAgents/com.hatchabot.control-plane.plist"
  mkdir -p "$HOME/Library/LaunchAgents" data
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.hatchabot.control-plane</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-c</string>
    <string>cd "$REPO" &amp;&amp; set -a &amp;&amp; . ./.env &amp;&amp; set +a &amp;&amp; exec ./node_modules/.bin/tsx src/index.ts</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$NODE_DIR:$DOCKER_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$REPO/data/server.log</string>
  <key>StandardErrorPath</key><string>$REPO/data/server.log</string>
</dict></plist>
PLIST
  launchctl unload -w "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
  echo "Manage with: launchctl {load|unload} -w $PLIST"
  echo "Logs: tail -f $REPO/data/server.log"

  # Nightly backups — the launchd counterpart of the systemd timer Linux hosts
  # get; without it a macOS host has no automatic backups at all.
  BACKUP_PLIST="$HOME/Library/LaunchAgents/com.hatchabot.backup.plist"
  cat > "$BACKUP_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.hatchabot.backup</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-c</string>
    <string>cd "$REPO" &amp;&amp; set -a &amp;&amp; . ./.env &amp;&amp; set +a &amp;&amp; exec ./scripts/backup-volumes.sh</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$NODE_DIR:$DOCKER_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key><string>$REPO/data/backup.log</string>
  <key>StandardErrorPath</key><string>$REPO/data/backup.log</string>
</dict></plist>
PLIST
  launchctl unload -w "$BACKUP_PLIST" 2>/dev/null || true
  launchctl load -w "$BACKUP_PLIST"
  echo "Nightly backups at 03:30: launchctl {load|unload} -w $BACKUP_PLIST"
else
  say "Installing the systemd user service…"
  ./scripts/install-service.sh
fi

say "Linking the hatchabot CLI…"
# On a system-wide Node (NodeSource, distro packages) the global folder is
# root-owned and `npm link` dies with EACCES; this used to print instructions
# and leave a fresh Linux install with no command (found by a clean-VM install,
# 2026-09-23). link-cli.sh falls back to ~/.npm-global and puts it on PATH.
# The CLI is optional, so a failure here never sinks the setup.
./scripts/link-cli.sh --no-doctor || echo "⚠ Could not link the hatchabot command — run ./scripts/link-cli.sh later."
mkdir -p ~/.config/hatchabot
# The CLI assumes port 8080: an install on another port (a tenant on a shared
# host, a second install) tells it here so `hbt` works without --url.
P="$(sed -n 's/^PORT=//p' .env | sed -n 1p)"
if [ -n "$P" ] && [ "$P" != 8080 ] && ! grep -q '^HATCHABOT_URL=' ~/.config/hatchabot/env 2>/dev/null; then
  echo "HATCHABOT_URL=http://127.0.0.1:$P" >> ~/.config/hatchabot/env
fi
if ! grep -q '^HATCHABOT_PASSWORD=' ~/.config/hatchabot/env 2>/dev/null; then
  # A hand-written .env may have no password line (e.g. identity mode) —
  # the CLI prompts in that case, so don't let set -e die on the last step.
  grep '^HATCHABOT_PASSWORD=' .env >> ~/.config/hatchabot/env || true
fi
chmod 600 ~/.config/hatchabot/env

say "Done. Next steps:"
cat <<'EOF'
  1. Open http://localhost:${HATCHABOT_SETUP_PORT:-8080} on THIS machine. With family accounts you
     create your own account there (you become its owner); with a shared
     password you unlock with it.
  2. Connect an AI source (⚙ AI). Three options:
       - a Claude Pro/Max login already on this machine (one tap),
       - an API key,
       - a local model server you run yourself (Ollama) — no credential,
         nothing leaves this machine. See "Running on your own hardware"
         in README.md.
  3. Create an agent — or import one:  hatchabot import <file>.hatchabot
     (Remember: the exported copy on the old machine stays STOPPED.)
  4. Off-LAN access for invitees: see docs/tailscale.md.
EOF
