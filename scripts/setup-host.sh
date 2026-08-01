#!/usr/bin/env bash
# One-command setup for a fresh AgentClaw host (e.g. the desktop you're
# importing an agent onto). Safe to re-run: every step is idempotent.
#
#   git clone https://github.com/cksci/agentclaw-ai.git agentclaw
#   cd agentclaw && ./scripts/setup-host.sh
#
# What it does: checks prerequisites, installs dependencies, writes a .env
# (random secret key + the password you choose), builds the runtime image,
# installs the systemd user service, and links the `agentclaw` CLI.
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
npm install

if [ ! -f .env ]; then
  say "Creating .env…"
  read -r -s -p "Choose an app password (what you'll type to open the web app): " PW; echo
  [ -n "$PW" ] || { echo "Password cannot be empty."; exit 1; }
  {
    echo "AGENTCLAW_SECRET_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
    echo "AGENTCLAW_PASSWORD=$PW"
    echo "PORT=8080"
    echo "# Set when reachable beyond localhost, e.g. via Tailscale — used in invite links:"
    echo "# AGENTCLAW_PUBLIC_URL=http://<this-machine>.<tailnet>.ts.net:8080"
  } > .env
  chmod 600 .env
else
  say ".env already exists — keeping it."
fi

if docker image inspect agentclaw-runtime:latest >/dev/null 2>&1; then
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
  # launchd's default PATH is /usr/bin:/bin — node (Homebrew/nvm) lives
  # elsewhere, so bake its real location into the service environment.
  NODE_DIR="$(dirname "$(command -v node)")"
  PLIST="$HOME/Library/LaunchAgents/com.agentclaw.control-plane.plist"
  mkdir -p "$HOME/Library/LaunchAgents" data
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agentclaw.control-plane</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-c</string>
    <string>cd "$REPO" &amp;&amp; set -a &amp;&amp; . ./.env &amp;&amp; set +a &amp;&amp; exec ./node_modules/.bin/tsx src/index.ts</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$NODE_DIR:/usr/bin:/bin</string>
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
else
  say "Installing the systemd user service…"
  ./scripts/install-service.sh
fi

say "Linking the agentclaw CLI…"
npm link >/dev/null
mkdir -p ~/.config/agentclaw
if ! grep -q '^AGENTCLAW_PASSWORD=' ~/.config/agentclaw/env 2>/dev/null; then
  grep '^AGENTCLAW_PASSWORD=' .env >> ~/.config/agentclaw/env
  chmod 600 ~/.config/agentclaw/env
fi

say "Done. Next steps:"
cat <<'EOF'
  1. Open http://localhost:8080 and unlock with your password.
  2. Connect an AI source (⚙ AI): if this machine has a Claude Pro/Max login
     (`claude` CLI, logged in), one tap; otherwise paste an API key.
  3. Create an agent — or import one:  agentclaw import <file>.agentclaw
     (Remember: the exported copy on the old machine stays STOPPED.)
  4. Off-LAN access for invitees: see docs/tailscale.md.
EOF
