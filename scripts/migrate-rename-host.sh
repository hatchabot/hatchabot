#!/usr/bin/env bash
# Move a host that was installed as AgentClaw (pre-1.0) over to the Hatchabot
# name, in place, without touching any agent container or volume.
#
#   scripts/migrate-rename-host.sh v1.1.0 --yes [--old <dir>]
#
# <dir> is the checkout the agentclaw service runs from (default: read from
# the live agentclaw.service unit, else ~/agentclaw-prod, else ~/agentclaw).
# Linux + systemd --user only; macOS/launchd hosts: see docs/releasing.md.
#
# Steps (each is skipped when already done, so re-running is safe):
#   1. docker tag  agentclaw-runtime:*  ->  hatchabot-runtime:*   (tags only)
#   2. clone the Hatchabot repo to ~/hatchabot-prod at the given tag, npm ci
#   3. copy .env / .env.mgmt across, renaming AGENTCLAW_* keys; pin HATCHABOT_DB
#   4. stop the agentclaw units; move the DB (wherever it lives) to
#      ~/hatchabot-data/hatchabot.sqlite and ~/agentclaw-backups -> ~/hatchabot-backups,
#      leaving symlinks (dir AND the old DB filename) so the old checkout still boots
#   5. render hatchabot* systemd units from deploy/ templates, enable, start
#   6. CLI wrapper + ~/.config/hatchabot/env (copied from the agentclaw one)
# Nothing is deleted: the old checkout and unit files stay for rollback.
set -euo pipefail
TAG="${1:?usage: migrate-rename-host.sh vX.Y.Z --yes [--old <dir>]}"
[ "${2:-}" = "--yes" ] || { echo "Re-run with --yes to actually migrate (control plane pauses ~1 minute; agents keep running)."; exit 1; }
[ "$(uname -s)" = "Linux" ] || { echo "This script handles Linux/systemd hosts. For macOS (launchd) follow docs/releasing.md → Renamed install."; exit 1; }
command -v systemctl >/dev/null || { echo "systemctl not found — this script needs systemd --user."; exit 1; }
OLD="${4:-}"; [ "${3:-}" = "--old" ] || OLD=""
[ -n "$OLD" ] || OLD="$(systemctl --user show -p WorkingDirectory --value agentclaw.service 2>/dev/null | sed "s|^%h|$HOME|" || true)"
[ -n "$OLD" ] && [ -d "$OLD" ] || { for d in "$HOME/agentclaw-prod" "$HOME/agentclaw"; do [ -f "$d/.env" ] && { OLD="$d"; break; }; done; }
[ -n "$OLD" ] && [ -f "$OLD/.env" ] || { echo "Can't find the AgentClaw checkout (no agentclaw.service, no ~/agentclaw-prod/.env, no ~/agentclaw/.env). Pass --old <dir>."; exit 1; }
REPO="${HATCHABOT_REPO:-https://github.com/hatchabot/hatchabot.git}"
NEW="$HOME/hatchabot-prod"; UNITS="$HOME/.config/systemd/user"; DATA="$HOME/hatchabot-data"
envval() { sed -n "s/^$2=//p" "$1" | sed -n 1p | sed -e 's/[[:space:]]*#.*$//' -e "s/^['\"]//" -e "s/['\"]$//"; }
say() { printf '\n== %s\n' "$*"; }
echo "Old checkout: $OLD"

# Where is the database now? (env, else the checkout's data/ dir)
OLD_DB="$(envval "$OLD/.env" AGENTCLAW_DB)"; OLD_DB="${OLD_DB:-$(envval "$OLD/.env" HATCHABOT_DB)}"
[ -n "$OLD_DB" ] || OLD_DB="$OLD/data/agentclaw.sqlite"
case "$OLD_DB" in /*) ;; *) OLD_DB="$OLD/$OLD_DB" ;; esac
[ -f "$OLD_DB" ] || { echo "Database not found at $OLD_DB — refusing to migrate without the registry."; exit 1; }
echo "Database:     $OLD_DB"

say "1. Docker image tags"
for t in $(docker images --format '{{.Tag}}' agentclaw-runtime 2>/dev/null); do
  if docker image inspect "hatchabot-runtime:$t" >/dev/null 2>&1; then echo "   hatchabot-runtime:$t exists"; else docker tag "agentclaw-runtime:$t" "hatchabot-runtime:$t"; echo "   tagged hatchabot-runtime:$t"; fi
done

say "2. Production checkout at $NEW ($TAG)"
if [ ! -d "$NEW/.git" ]; then git clone --quiet "$REPO" "$NEW"; fi
git -C "$NEW" fetch --tags --force --quiet origin
git -C "$NEW" checkout --quiet "$TAG"
( cd "$NEW" && npm ci --silent )

say "3. Env files"
esc() { printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'; }
rewrite_env() { sed -e 's/^AGENTCLAW_/HATCHABOT_/' -e "s|$(esc "$HOME")/agentclaw-backups|$HOME/hatchabot-backups|g" -e "s|$(esc "$OLD")|$NEW|g" "$1" | grep -vE '^HATCHABOT_DB=' > "$2"; chmod 600 "$2"; }
for f in .env .env.mgmt; do [ -f "$OLD/$f" ] && { rewrite_env "$OLD/$f" "$NEW/$f"; echo "   $NEW/$f"; }; done
printf 'HATCHABOT_DB=%s\n' "$DATA/hatchabot.sqlite" >> "$NEW/.env"; echo "   HATCHABOT_DB=$DATA/hatchabot.sqlite"
for f in .env .env.mgmt; do [ -f "$NEW/$f" ] && grep -oE "$NEW/[^ ]*\.(pem|crt|key)" "$NEW/$f" | while read -r p; do [ -e "$p" ] || echo "   ⚠ $f references $p which does not exist yet — copy it from $OLD before starting"; done; done

say "4. Stop old units, move data + backups"
systemctl --user stop agentclaw-mgmt-bot.service agentclaw.service agentclaw-backup.timer 2>/dev/null || true
if [ ! -f "$DATA/hatchabot.sqlite" ]; then
  mkdir -p "$DATA"
  for s in "" -wal -shm; do [ -e "$OLD_DB$s" ] && mv "$OLD_DB$s" "$DATA/hatchabot.sqlite$s"; done
  ln -s "$DATA/hatchabot.sqlite" "$OLD_DB"   # the old checkout still boots (rollback)
  echo "   $DATA/hatchabot.sqlite (old path is now a symlink to it)"
  for extra in derived-builds mgmt-cli-home; do [ -d "$(dirname "$OLD_DB")/$extra" ] && [ ! -e "$DATA/$extra" ] && mv "$(dirname "$OLD_DB")/$extra" "$DATA/$extra"; done
fi
[ -e "$HOME/agentclaw-data" ] || [ "$(dirname "$OLD_DB")" != "$HOME/agentclaw-data" ] || true
if [ -d "$HOME/agentclaw-backups" ] && [ ! -L "$HOME/agentclaw-backups" ]; then
  mv "$HOME/agentclaw-backups" "$HOME/hatchabot-backups"; ln -s "$HOME/hatchabot-backups" "$HOME/agentclaw-backups"; echo "   ~/hatchabot-backups (symlink left at ~/agentclaw-backups)"
fi

say "5. systemd units (from deploy/ templates)"
mkdir -p "$UNITS"
SVC_PATH="$NEW/node_modules/.bin:$PATH"
for u in hatchabot.service hatchabot-backup.service hatchabot-mgmt-bot.service hatchabot-backup.timer; do
  [ -f "$NEW/deploy/$u" ] || continue
  [ "$u" = hatchabot-mgmt-bot.service ] && [ ! -f "$NEW/.env.mgmt" ] && continue
  sed -e "s|__HATCHABOT_DIR__|$(esc "$NEW")|g" -e "s|__HATCHABOT_PATH__|$(esc "$SVC_PATH")|g" "$NEW/deploy/$u" > "$UNITS/$u"; echo "   $u"
done
systemctl --user daemon-reload
systemctl --user disable agentclaw.service agentclaw-mgmt-bot.service agentclaw-backup.timer 2>/dev/null || true
systemctl --user enable --now hatchabot.service hatchabot-backup.timer
[ -f "$NEW/.env.mgmt" ] && systemctl --user enable --now hatchabot-mgmt-bot.service

say "6. CLI wrapper + config"
mkdir -p "$HOME/.local/bin"
printf '#!/usr/bin/env bash\ncd "%s" && exec node_modules/.bin/tsx src/cli.ts "$@"\n' "$NEW" > "$HOME/.local/bin/hatchabot"; chmod +x "$HOME/.local/bin/hatchabot"
ln -sf "$HOME/.local/bin/hatchabot" "$HOME/.local/bin/agentclaw"
if [ -f "$HOME/.config/agentclaw/env" ] && [ ! -f "$HOME/.config/hatchabot/env" ]; then
  mkdir -p "$HOME/.config/hatchabot"; sed 's/^AGENTCLAW_/HATCHABOT_/' "$HOME/.config/agentclaw/env" > "$HOME/.config/hatchabot/env"; chmod 600 "$HOME/.config/hatchabot/env"; echo "   ~/.config/hatchabot/env"
fi

say "7. Health"
PORT="$(envval "$NEW/.env" PORT)"; PORT="${PORT:-8080}"
URL="${HATCHABOT_HEALTH_URL:-http://127.0.0.1:$PORT/}"
WANT="$(node -e 'console.log(require(process.argv[1]).version)' "$NEW/package.json")"
for i in $(seq 1 30); do
  GOT="$(curl -sk "$URL" 2>/dev/null | grep -oE 'HATCHABOT_VERSION="[^"]+"' | sed -n 1p | cut -d'"' -f2 || true)"
  [ "$GOT" = "$WANT" ] && { echo "   serving Hatchabot $GOT at $URL"; echo; echo "Done. Old checkout kept at $OLD; remove it once you're happy: rm -rf $OLD $UNITS/agentclaw*"; exit 0; }
  sleep 2
done
echo "   not serving $WANT yet — journalctl --user -u hatchabot -n 50"; exit 1
