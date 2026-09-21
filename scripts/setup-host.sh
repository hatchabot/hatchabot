#!/usr/bin/env bash
# One-command setup for a fresh Hatchabot host (e.g. the desktop you're
# importing an agent onto). Safe to re-run: every step is idempotent.
#
#   git clone https://github.com/hatchabot/hatchabot.git hatchabot
#   cd hatchabot && ./scripts/setup-host.sh
#
# What it does: checks prerequisites, installs dependencies, writes a .env
# (random secret key + the password you choose), builds the runtime image,
# installs the systemd user service, and links the `hatchabot` CLI.
set -euo pipefail
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
  echo "How will people sign in?"
  echo "  1) An account for each person — their own agents, and a forgotten"
  echo "     password is a link you send them  (recommended)"
  echo "  2) One shared password"
  read -r -p "Choose [1]: " SIGNIN
  SIGNIN="${SIGNIN:-1}"
  PW=""
  if [ "$SIGNIN" = "2" ]; then
    read -r -s -p "Choose an app password (what you'll type to open the web app): " PW; echo
    [ -n "$PW" ] || { echo "Password cannot be empty."; exit 1; }
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
    echo "PORT=8080"
    echo "# Set when reachable beyond localhost, e.g. via Tailscale — used in invite links:"
    echo "# HATCHABOT_PUBLIC_URL=http://<this-machine>.<tailnet>.ts.net:8080"
  } > .env
  chmod 600 .env
else
  say ".env already exists — keeping it."
fi

if docker image inspect hatchabot-runtime:latest >/dev/null 2>&1; then
  # An existing install may have promoted a NEWER image to :latest — a default
  # build here would silently demote it (learned the hard way).
  say "Runtime image already present — keeping the existing :latest."
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
# On a system-wide Node the global prefix (/usr/lib) is root-owned and
# `npm link` dies with EACCES — the CLI is optional, so don't sink the setup.
if ! npm link >/dev/null; then
  echo "⚠ npm link failed (usually EACCES on a system-wide Node). To fix:"
  echo "    npm config set prefix ~/.npm-global"
  echo "    add ~/.npm-global/bin to your PATH, then re-run: npm link"
fi
mkdir -p ~/.config/hatchabot
if ! grep -q '^HATCHABOT_PASSWORD=' ~/.config/hatchabot/env 2>/dev/null; then
  # A hand-written .env may have no password line (e.g. identity mode) —
  # the CLI prompts in that case, so don't let set -e die on the last step.
  grep '^HATCHABOT_PASSWORD=' .env >> ~/.config/hatchabot/env || true
fi
chmod 600 ~/.config/hatchabot/env

say "Done. Next steps:"
cat <<'EOF'
  1. Open http://localhost:8080 on THIS machine. With family accounts you
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
