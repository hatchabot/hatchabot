#!/usr/bin/env bash
# Move a host that was installed as AgentClaw (pre-1.0) over to the Hatchabot
# name, in place, without touching any agent container or volume.
#
#   scripts/migrate-rename-host.sh v1.0.0 --yes
#
# What it does (each step is skipped if already done, so re-running is safe):
#   1. docker tag  agentclaw-runtime:*  ->  hatchabot-runtime:*   (tags only; no rebuild)
#   2. clone the Hatchabot repo to ~/hatchabot-prod at the given tag, npm ci
#   3. copy .env / .env.mgmt across, renaming AGENTCLAW_* keys and old paths
#   4. stop the agentclaw units; move ~/agentclaw-data -> ~/hatchabot-data
#      (agentclaw.sqlite -> hatchabot.sqlite) and ~/agentclaw-backups -> ~/hatchabot-backups,
#      leaving symlinks at the old paths
#   5. write hatchabot* systemd units from the live agentclaw* ones, enable, start
#   6. install the `hatchabot` CLI wrapper (and keep `agentclaw` as an alias)
# Nothing is deleted: ~/agentclaw-prod and the old unit files stay for rollback.
set -euo pipefail
TAG="${1:?usage: migrate-rename-host.sh vX.Y.Z --yes}"
[ "${2:-}" = "--yes" ] || { echo "Re-run with --yes to actually migrate (this stops the control plane for ~1 minute; agents keep running)."; exit 1; }
REPO="${HATCHABOT_REPO:-https://github.com/hatchabot/hatchabot.git}"
OLD="$HOME/agentclaw-prod"; NEW="$HOME/hatchabot-prod"
UNITS="$HOME/.config/systemd/user"
[ -d "$OLD" ] || { echo "No $OLD — nothing to migrate."; exit 1; }
[ -f "$OLD/.env" ] || { echo "$OLD/.env missing."; exit 1; }
say() { printf '\n== %s\n' "$*"; }

say "1. Docker image tags"
for t in $(docker images --format '{{.Tag}}' agentclaw-runtime 2>/dev/null); do
  if docker image inspect "hatchabot-runtime:$t" >/dev/null 2>&1; then echo "   hatchabot-runtime:$t exists"; else docker tag "agentclaw-runtime:$t" "hatchabot-runtime:$t"; echo "   tagged hatchabot-runtime:$t"; fi
done

say "2. Production checkout at $NEW ($TAG)"
if [ ! -d "$NEW/.git" ]; then git clone --quiet "$REPO" "$NEW"; fi
git -C "$NEW" fetch --tags --quiet origin
git -C "$NEW" checkout --quiet "$TAG"
( cd "$NEW" && npm ci --silent )

say "3. Env files"
rewrite_env() { sed -e 's/^AGENTCLAW_/HATCHABOT_/' -e "s|$HOME/agentclaw-data|$HOME/hatchabot-data|g" -e "s|$HOME/agentclaw-backups|$HOME/hatchabot-backups|g" -e "s|$HOME/agentclaw-prod|$HOME/hatchabot-prod|g" -e 's|agentclaw\.sqlite|hatchabot.sqlite|g' "$1" > "$2"; chmod 600 "$2"; }
for f in .env .env.mgmt; do [ -f "$OLD/$f" ] && { rewrite_env "$OLD/$f" "$NEW/$f"; echo "   $NEW/$f"; }; done

say "4. Stop old units, move data + backups"
systemctl --user stop agentclaw-mgmt-bot.service agentclaw.service agentclaw-backup.timer 2>/dev/null || true
if [ -d "$HOME/agentclaw-data" ] && [ ! -L "$HOME/agentclaw-data" ]; then
  mv "$HOME/agentclaw-data" "$HOME/hatchabot-data"
  for s in "" -wal -shm; do [ -e "$HOME/hatchabot-data/agentclaw.sqlite$s" ] && mv "$HOME/hatchabot-data/agentclaw.sqlite$s" "$HOME/hatchabot-data/hatchabot.sqlite$s"; done
  ln -s "$HOME/hatchabot-data" "$HOME/agentclaw-data"; echo "   ~/hatchabot-data (symlink left at ~/agentclaw-data)"
fi
if [ -d "$HOME/agentclaw-backups" ] && [ ! -L "$HOME/agentclaw-backups" ]; then
  mv "$HOME/agentclaw-backups" "$HOME/hatchabot-backups"; ln -s "$HOME/hatchabot-backups" "$HOME/agentclaw-backups"; echo "   ~/hatchabot-backups (symlink left at ~/agentclaw-backups)"
fi

say "5. systemd units"
for u in agentclaw.service agentclaw-mgmt-bot.service agentclaw-backup.service agentclaw-backup.timer; do
  [ -f "$UNITS/$u" ] || continue
  n="${u/agentclaw/hatchabot}"
  sed -e 's/AgentClaw/Hatchabot/g' -e 's/agentclaw/hatchabot/g' "$UNITS/$u" > "$UNITS/$n"; echo "   $n"
done
systemctl --user daemon-reload
systemctl --user disable agentclaw.service agentclaw-mgmt-bot.service agentclaw-backup.timer 2>/dev/null || true
systemctl --user enable --now hatchabot.service hatchabot-backup.timer
[ -f "$NEW/.env.mgmt" ] && systemctl --user enable --now hatchabot-mgmt-bot.service

say "6. CLI wrapper"
mkdir -p "$HOME/.local/bin"
printf '#!/usr/bin/env bash\ncd "%s" && exec node_modules/.bin/tsx src/cli.ts "$@"\n' "$NEW" > "$HOME/.local/bin/hatchabot"; chmod +x "$HOME/.local/bin/hatchabot"
ln -sf "$HOME/.local/bin/hatchabot" "$HOME/.local/bin/agentclaw"

say "7. Health"
PORT="$(sed -n 's/^PORT=//p' "$NEW/.env" | head -1)"; PORT="${PORT:-8080}"
WANT="$(node -e 'console.log(require(process.argv[1]).version)' "$NEW/package.json")"
for i in $(seq 1 30); do
  GOT="$(curl -s "http://127.0.0.1:$PORT/" 2>/dev/null | grep -oE 'HATCHABOT_VERSION="[^"]+"' | head -1 | cut -d'"' -f2 || true)"
  [ "$GOT" = "$WANT" ] && { echo "   serving Hatchabot $GOT on :$PORT"; echo; echo "Done. Old checkout kept at $OLD; remove it once you're happy: rm -rf $OLD $UNITS/agentclaw*"; exit 0; }
  sleep 2
done
echo "   not serving $WANT yet — journalctl --user -u hatchabot -n 50"; exit 1
