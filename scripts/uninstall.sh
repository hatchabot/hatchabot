#!/usr/bin/env bash
# Removes a Hatchabot install — the reverse of scripts/setup-host.sh.
#
#   ./scripts/uninstall.sh              # stop it: service, units, CLI link; agents stopped
#   ./scripts/uninstall.sh --purge      # …and the data: volumes, database, images, network
#   ./scripts/uninstall.sh --purge --backups --yes
#
# Without --purge NOTHING you would miss is deleted: agent volumes (memory,
# files, members), the database, the backups and the runtime image all stay,
# so re-running setup-host.sh brings the same fleet back. --purge is the clean
# slate, and it asks you to type the word first.
#
# The clone you are standing in is never deleted — the last line tells you how.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"

PURGE=0; BACKUPS=0; ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --backups) BACKUPS=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)"; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# A production install runs from its own checkout (see docs/releasing.md), so
# the .env that names the database may not be the one in the clone you are
# standing in. Believe the installed unit.
UNIT="$HOME/.config/systemd/user/hatchabot.service"
INSTALLED_DIR=""
if [ -f "$UNIT" ]; then
  INSTALLED_DIR="$(sed -n 's/^WorkingDirectory=//p' "$UNIT" | head -1)"
  INSTALLED_DIR="${INSTALLED_DIR/#\%h/$HOME}"
fi
ENV_DIR="$REPO"
if [ -n "$INSTALLED_DIR" ] && [ "$INSTALLED_DIR" != "$REPO" ] && [ -d "$INSTALLED_DIR" ]; then
  ENV_DIR="$INSTALLED_DIR"
  printf '\033[1mNote:\033[0m the service runs from %s, not this clone — reading its .env for paths.\n' "$INSTALLED_DIR"
fi

# Where the data lives, read the same way the server reads it.
[ -f "$ENV_DIR/.env" ] && set -a && . "$ENV_DIR/.env" 2>/dev/null; set +a
BACKUP_DIR="${HATCHABOT_BACKUP_DIR:-$HOME/hatchabot-backups}"
DB_PATH="${HATCHABOT_DB:-$ENV_DIR/data/hatchabot.sqlite}"
DATA_DIR="$(dirname "$DB_PATH")"

# Containers and volumes belong to Hatchabot by name: agentclaw- is the old
# prefix, still worn by agents made before the rename.
containers() { docker ps -aq --filter "name=^/hatchabot-" --filter "name=^/agentclaw-" 2>/dev/null; }
volumes() { docker volume ls -q 2>/dev/null | grep -E '^(hatchabot|agentclaw)-.*-vol$'; }
images() { docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^hatchabot-runtime:'; }

say "This install"
echo "  repo:      $REPO"
[ "$ENV_DIR" != "$REPO" ] && echo "  installed: $ENV_DIR (what the service runs)"
echo "  data:      $DATA_DIR $([ -f "$DB_PATH" ] && echo "(database present)" || echo "(no database)")"
echo "  backups:   $BACKUP_DIR $([ -d "$BACKUP_DIR" ] && echo "($(ls -1 "$BACKUP_DIR" 2>/dev/null | wc -l | tr -d ' ') sets)" || echo "(none)")"
if have docker; then
  echo "  agents:    $(containers | wc -l | tr -d ' ') containers, $(volumes | wc -l | tr -d ' ') volumes"
  echo "  images:    $(images | wc -l | tr -d ' ') runtime images"
fi
echo
if [ "$PURGE" = 1 ]; then
  echo "  MODE: --purge — agent volumes, the database$([ "$BACKUPS" = 1 ] && echo ", the backups"), the runtime images"
  echo "        and the docker network will be DELETED. Agents cannot be recovered$([ "$BACKUPS" = 1 ] && echo " (not even from a backup)")."
else
  echo "  MODE: service only — agents are STOPPED, not deleted, and their"
  echo "        volumes, the database, the backups and the images are KEPT."
  echo "        Re-run scripts/setup-host.sh and start them again."
fi

if [ "$ASSUME_YES" != 1 ]; then
  if [ "$PURGE" = 1 ]; then
    printf '\nType "purge" to confirm: '; read -r ans
    [ "$ans" = "purge" ] || { echo "Nothing done."; exit 1; }
  else
    printf '\nUninstall the service? [y/N] '; read -r ans
    case "$ans" in y|Y|yes|YES) ;; *) echo "Nothing done."; exit 1 ;; esac
  fi
fi

say "Stopping the service…"
if [ "$(uname -s)" = "Darwin" ]; then
  for p in com.hatchabot.control-plane com.hatchabot.backup; do
    PLIST="$HOME/Library/LaunchAgents/$p.plist"
    [ -f "$PLIST" ] && launchctl unload -w "$PLIST" 2>/dev/null; rm -f "$PLIST" && echo "  removed $p"
  done
else
  for unit in hatchabot.service hatchabot-backup.timer hatchabot-backup.service hatchabot-mgmt-bot.service; do
    if systemctl --user list-unit-files "$unit" >/dev/null 2>&1 && [ -f "$HOME/.config/systemd/user/$unit" ]; then
      systemctl --user disable --now "$unit" >/dev/null 2>&1
      rm -f "$HOME/.config/systemd/user/$unit"
      echo "  removed $unit"
    fi
  done
  systemctl --user daemon-reload
fi

say "Unlinking the hatchabot CLI…"
npm unlink -g hatchabot >/dev/null 2>&1 && echo "  unlinked" || echo "  (was not linked)"
[ -f "$HOME/.config/hatchabot/env" ] && rm -f "$HOME/.config/hatchabot/env" && echo "  removed ~/.config/hatchabot/env"

if have docker; then
  # STOPPED, not removed. The control plane only mends states — it never
  # re-creates a runtime on its own — so removing containers would leave every
  # agent needing a Rebuild after a reinstall, which is not "nothing you would
  # miss is deleted". --purge removes them below.
  say "Stopping agents…"
  CIDS="$(containers)"
  if [ -n "$CIDS" ]; then
    # shellcheck disable=SC2086
    docker stop $CIDS >/dev/null 2>&1
    echo "  stopped $(echo "$CIDS" | wc -l | tr -d ' ') containers (kept, with their volumes)"
  else
    echo "  none running"
  fi
fi

if [ "$PURGE" = 1 ]; then
  if have docker; then
    say "Removing agent containers…"
    CIDS="$(containers)"
    if [ -n "$CIDS" ]; then
      # shellcheck disable=SC2086
      docker rm -f $CIDS >/dev/null 2>&1 && echo "  removed $(echo "$CIDS" | wc -l | tr -d ' ') containers"
    fi
    say "Deleting agent volumes…"
    VOLS="$(volumes)"
    if [ -n "$VOLS" ]; then
      # shellcheck disable=SC2086
      docker volume rm $VOLS >/dev/null 2>&1 && echo "  removed $(echo "$VOLS" | wc -l | tr -d ' ') volumes"
    else
      echo "  none"
    fi
    say "Deleting runtime images…"
    IMGS="$(images)"
    if [ -n "$IMGS" ]; then
      # shellcheck disable=SC2086
      docker rmi -f $IMGS >/dev/null 2>&1 && echo "  removed $(echo "$IMGS" | wc -l | tr -d ' ') images"
    else
      echo "  none"
    fi
    docker network rm hatchabot-agents >/dev/null 2>&1 && echo "  removed the hatchabot-agents network"
  fi
  say "Deleting local state…"
  rm -rf "$DATA_DIR" && echo "  removed $DATA_DIR"
  [ -f "$ENV_DIR/.env" ] && rm -f "$ENV_DIR/.env" && echo "  removed $ENV_DIR/.env"
  if [ "$BACKUPS" = 1 ] && [ -d "$BACKUP_DIR" ]; then
    rm -rf "$BACKUP_DIR" && echo "  removed $BACKUP_DIR"
  elif [ -d "$BACKUP_DIR" ]; then
    echo "  kept $BACKUP_DIR (pass --backups to delete it too)"
  fi
fi

say "Done."
echo "Hatchabot is no longer running or installed on this machine."
if [ "$PURGE" = 1 ]; then
  echo "Its agents, volumes and database are gone."
  if [ "$BACKUPS" != 1 ] && [ -d "$BACKUP_DIR" ]; then echo "Backups remain in $BACKUP_DIR (--backups removes them)."; fi
else
  # "I uninstalled it and the agents came back" is the predictable surprise:
  # the default keeps everything on purpose. Say exactly what survived, with
  # counts, and the one command that does not.
  echo
  echo "KEPT ON PURPOSE — a reinstall picks all of this up again:"
  if have docker; then
    echo "  · $(containers | wc -l | tr -d " ") agent containers (stopped)"
    echo "  · $(volumes | wc -l | tr -d " ") agent volumes — their memory, files and members"
    echo "  · $(images | wc -l | tr -d " ") runtime images"
  fi
  [ -f "$DB_PATH" ] && echo "  · the database at $DB_PATH — every agent, member and setting"
  [ -d "$BACKUP_DIR" ] && echo "  · $(ls -1 "$BACKUP_DIR" 2>/dev/null | wc -l | tr -d " ") backup sets in $BACKUP_DIR"
  echo
  echo "For a clean slate instead:  ./scripts/uninstall.sh --purge --backups"
fi
echo "The clone itself is untouched. To remove it:  rm -rf \"$REPO\""
echo "Telegram bots are not deletable from here: @BotFather → /mybots → /deletebot."
