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
#   3. stop the agentclaw units (while one still runs, stops here, before
#      an env file is written or anything is moved)
#   4. copy .env / .env.mgmt across, renaming AGENTCLAW_* keys; pin HATCHABOT_DB
#   5. move the DB (wherever it lives) to
#      ~/hatchabot-data/hatchabot.sqlite and ~/agentclaw-backups -> ~/hatchabot-backups,
#      leaving symlinks (dir AND the old DB filename) so the old checkout still boots
#   6. render hatchabot* systemd units from deploy/ templates, enable, start
#   7. CLI wrapper + ~/.config/hatchabot/env (copied from the agentclaw one)
# Nothing is deleted: the old checkout and unit files stay for rollback.
# Another install already at ~/hatchabot-prod, ~/hatchabot-data or
# ~/hatchabot-backups, a systemd that cannot be asked about the old units
# (run through su or sudo -u), or a backup of the old install running, is
# refused before step 1, nothing changed. A run that stops after step 3 says
# how to start AgentClaw again, or, with the new service running, not to,
# and first to link a database it moved and had not linked yet.
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
BACKUPS_LINK="$HOME/agentclaw-backups.moved"   # step 5: the link to the moved backups, until it is in place
envval() { sed -n "s/^$2=//p" "$1" | sed -n 1p | sed -e 's/[[:space:]]*#.*$//' -e "s/^['\"]//" -e "s/['\"]$//"; }
say() { printf '\n== %s\n' "$*"; }
echo "Old checkout: $OLD"

# Where is the database now? (env, else the checkout's data/ dir)
OLD_DB="$(envval "$OLD/.env" AGENTCLAW_DB)"; OLD_DB="${OLD_DB:-$(envval "$OLD/.env" HATCHABOT_DB)}"
[ -n "$OLD_DB" ] || OLD_DB="$OLD/data/agentclaw.sqlite"
case "$OLD_DB" in /*) ;; *) OLD_DB="$OLD/$OLD_DB" ;; esac
[ -f "$OLD_DB" ] || { echo "Database not found at $OLD_DB — refusing to migrate without the registry."; exit 1; }
echo "Database:     $OLD_DB"

# The env files (step 4). They hold the secret key and tokens: made 600 from
# the start (umask 077), not world-readable until the chmod after them
# (review, 2026-10-09). would_write: the .env this migration writes.
# `{ grep || true; }`: an old .env with no line but AGENTCLAW_DB, or none at
# all, leaves grep nothing to print, and its "no match" under pipefail ended
# the run at step 4, the old units stopped, an empty .env left behind
# (review of HB-1072).
esc() { printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'; }
# An `export AGENTCLAW_…` line is renamed too, as the plain one is: kept as
# it was, it named the old key, and an `export AGENTCLAW_DB=` line stayed
# beside the HATCHABOT_DB line written below (HB-1232).
rewrite_env() { ( umask 077; sed -e 's/^\(export[[:space:]][[:space:]]*\)\{0,1\}AGENTCLAW_/\1HATCHABOT_/' -e "s|$(esc "$HOME")/agentclaw-backups|$HOME/hatchabot-backups|g" -e "s|$(esc "$OLD")|$NEW|g" "$1" | { grep -vE '^(export[[:space:]]+)?HATCHABOT_DB=' || true; } > "$2" ); chmod 600 "$2"; }
would_write() { rewrite_env "$OLD/.env" "$1"; printf 'HATCHABOT_DB=%s\n' "$DATA/hatchabot.sqlite" >> "$1"; }
# put DEST CMD…: CMD writes a file beside DEST, which becomes DEST only once
# it is whole. A run cut off on the way leaves no part-written DEST, which a
# re-run would take for another install's (EXIT trap, below: PUT_TMP).
PUT_TMP=""
put() { local dst="$1"; shift; PUT_TMP="$(mktemp "$dst.XXXXXX")"; "$@" "$PUT_TMP"; mv -f "$PUT_TMP" "$dst"; PUT_TMP=""; chmod 600 "$dst"; }

# Where it goes must be empty, or what an earlier run of this migration made
# there. A separate Hatchabot install at ~/hatchabot-prod had its .env (its
# secret key) overwritten with this one's while its own database stayed,
# and its stored credentials could no longer be read (HB-1073). A .env is
# this migration's when it is what it writes, or holds this install's key:
# by the key alone, a re-run was refused when the AgentClaw .env had no
# plain AGENTCLAW_SECRET_KEY= line (HB-1073 review).
taken() { echo "$1 — nothing was changed. Move that install aside first, or migrate this one by hand (docs/releasing.md, \"Renamed install\")."; exit 1; }
ours_env() { local t rc=0; t="$(mktemp)"; { would_write "$t" && cmp -s "$t" "$NEW/.env"; } || rc=1; rm -f "$t"; return "$rc"; }
OLD_KEY="$(envval "$OLD/.env" AGENTCLAW_SECRET_KEY)"; OLD_KEY="${OLD_KEY:-$(envval "$OLD/.env" HATCHABOT_SECRET_KEY)}"
if [ -f "$NEW/.env" ] && ! ours_env; then
  if [ -z "$OLD_KEY" ]; then
    echo "$NEW/.env is there and is not what this migration writes from $OLD/.env, which has no AGENTCLAW_SECRET_KEY= line to tell by whose it is — nothing was changed."
    echo "If it is this install's, from an earlier run, move it aside (mv $NEW/.env $NEW/.env.before) and run this again. If it is another install's, move that install aside first."
    exit 1
  fi
  [ "$(envval "$NEW/.env" HATCHABOT_SECRET_KEY)" = "$OLD_KEY" ] \
    || taken "$NEW/.env belongs to another Hatchabot install: its HATCHABOT_SECRET_KEY is not this AgentClaw install's"
fi
if [ -e "$DATA/hatchabot.sqlite" ] && ! [ "$OLD_DB" -ef "$DATA/hatchabot.sqlite" ]; then
  taken "$DATA/hatchabot.sqlite is another install's database, not $OLD_DB moved there by an earlier run"
fi
# A link that leads nowhere is there too: -e follows it and says no, and
# step 5's mv then failed with the database already moved (review of HB-1116).
if [ -d "$HOME/agentclaw-backups" ] && [ ! -L "$HOME/agentclaw-backups" ] && { [ -e "$HOME/hatchabot-backups" ] || [ -L "$HOME/hatchabot-backups" ]; }; then
  taken "$HOME/hatchabot-backups is there already, and ~/agentclaw-backups would have been moved into it"
fi

# The old units, as the user's systemd sees them (step 3 stops them). For a
# unit it does not have, systemd says "inactive": a show that fails or says
# nothing means it could not be asked, as through su or sudo -u, where
# systemctl --user has no session of the user's to reach. That was taken for
# "not there", and the database moved under a service still running
# (HB-1072 review).
OLD_UNITS="agentclaw.service agentclaw-mgmt-bot.service agentclaw-backup.service"
unit_state() { UNIT_ST=""; UNIT_ST="$(systemctl --user show -p ActiveState --value "$1" 2>/dev/null)" && [ -n "$UNIT_ST" ]; }
no_manager() {
  echo "   systemd could not be asked whether $1 is running (systemctl --user show failed or said nothing) — $2"
  echo "   Run this as the user the AgentClaw service runs as, in that user's own login session, not through su or sudo -u (there systemctl --user cannot reach their systemd). systemctl --user status $1 says what it sees."
  exit 1
}
# A backup running now reads the database step 5 would move: refused here,
# before anything is stopped, not found running after the stop (review of
# HB-1072). MGMT_WAS: the management bot was there, to start it again too.
MGMT_WAS=0; [ ! -f "$UNITS/agentclaw-mgmt-bot.service" ] || MGMT_WAS=1
for u in $OLD_UNITS; do
  unit_state "$u" || no_manager "$u" "nothing was changed."
  case "$u:$UNIT_ST" in
    agentclaw-backup.service:inactive|agentclaw-backup.service:failed) ;;
    agentclaw-backup.service:*)
      echo "   A backup of AgentClaw is running (agentclaw-backup.service is $UNIT_ST) — nothing was changed: it reads the database this would move."
      echo "   Let it finish (systemctl --user status agentclaw-backup.service says when it has), then run this again."
      exit 1 ;;
    agentclaw-mgmt-bot.service:inactive) ;;
    agentclaw-mgmt-bot.service:*) MGMT_WAS=1 ;;
  esac
done
# From the stop (step 3) until the new service is started (step 6), a run
# that ends early, refused or failed, leaves AgentClaw stopped: it says so,
# and how to start it again (review of HB-1072). The old checkout still
# boots after step 5 (the old database path is a link to the moved one).
RESTART="agentclaw.service agentclaw-backup.timer"; [ "$MGMT_WAS" = 0 ] || RESTART="$RESTART agentclaw-mgmt-bot.service"
OLD_STOPPED=0
# Start AgentClaw again only while the new service is stopped: one that step
# 6 started before the timer's start failed, or an earlier run left running,
# runs on the moved database, and AgentClaw started beside it ran two control
# planes on the same agents (HB-1237). Asked only once there is a moved
# database for it to run on, or step 6 has tried to start it (NEW_STARTING):
# before that, a hatchabot.service is none of this run's (another install's),
# and systemd not answering then is no reason to keep AgentClaw down (review
# of HB-1237). Not active is not "running" either: one that cannot boot, with
# Restart=always, reads activating between its tries.
NEW_STARTING=0
on_exit() {
  local rc=$?
  [ -z "$PUT_TMP" ] || rm -f "$PUT_TMP"
  if [ "$rc" != 0 ] && [ "$OLD_STOPPED" = 1 ]; then
    # A database at the new path is this install's, moved: the checks before
    # step 1 refused any other. One a run left there between step 5's mv and
    # its ln has no link from the old path, and AgentClaw started on that
    # finds no database (review of HB-1237).
    if [ -e "$DATA/hatchabot.sqlite" ] && ! [ "$OLD_DB" -ef "$DATA/hatchabot.sqlite" ]; then
      echo "   AgentClaw's database is at $DATA/hatchabot.sqlite now, and its old path does not lead there yet. Before starting AgentClaw, or running this again: ln -s \"$DATA/hatchabot.sqlite\" \"$OLD_DB\""
    fi
    # Its backups moved, and the link to them not in place yet (HB-1350):
    # AgentClaw started so would make an empty ~/agentclaw-backups.
    if [ -L "$BACKUPS_LINK" ] && [ ! -e "$HOME/agentclaw-backups" ] && [ ! -L "$HOME/agentclaw-backups" ]; then
      echo "   AgentClaw's backups are in $HOME/hatchabot-backups now, and $HOME/agentclaw-backups does not lead there yet. Before starting AgentClaw: mv -T \"$BACKUPS_LINK\" \"$HOME/agentclaw-backups\" (running this again does it too)"
    fi
    if { [ "$NEW_STARTING" = 1 ] || [ -e "$DATA/hatchabot.sqlite" ]; } \
      && ! { unit_state hatchabot.service && { [ "$UNIT_ST" = inactive ] || [ "$UNIT_ST" = failed ]; }; }; then
      if [ "$UNIT_ST" = active ]; then
        echo "   Do not start AgentClaw again: hatchabot.service is active, on the moved database, and the two would run the same agents. See what went wrong above (systemctl --user status hatchabot.service hatchabot-backup.timer), then run this again."
      else
        echo "   Do not start AgentClaw again yet: hatchabot.service is ${UNIT_ST:-in a state systemd would not say} and may be starting on the moved database, and the two would run the same agents. See systemctl --user status hatchabot.service, then run this again."
      fi
      echo "   To go back to AgentClaw instead: systemctl --user disable --now hatchabot.service hatchabot-backup.timer, then systemctl --user start $RESTART"
    else
      echo "   This run stopped what it could of AgentClaw (step 3) and does not start it again. To run AgentClaw until this is sorted out: systemctl --user start $RESTART"
    fi
  fi
}
trap on_exit EXIT

say "1. Docker image tags"
for t in $(docker images --format '{{.Tag}}' agentclaw-runtime 2>/dev/null); do
  if docker image inspect "hatchabot-runtime:$t" >/dev/null 2>&1; then echo "   hatchabot-runtime:$t exists"; else docker tag "agentclaw-runtime:$t" "hatchabot-runtime:$t"; echo "   tagged hatchabot-runtime:$t"; fi
done

say "2. Production checkout at $NEW ($TAG)"
if [ ! -d "$NEW/.git" ]; then git clone --quiet "$REPO" "$NEW"; fi
git -C "$NEW" fetch --tags --force --quiet origin
git -C "$NEW" checkout --quiet "$TAG"
( cd "$NEW" && npm ci --silent )

say "3. Stop the old units"
OLD_STOPPED=1
systemctl --user stop agentclaw-mgmt-bot.service agentclaw.service agentclaw-backup.timer 2>/dev/null || true
# A unit that is not there, or not running, is fine; one still running after
# the stop is not. Its database moved as three files while it kept writing
# through them, and the new service then ran beside the old one on the same
# agents (HB-1072). A nightly backup running now holds the database too.
# Before the env files are written, so a run that stops here leaves nothing
# of this install's at the destination (HB-1072 review).
for u in $OLD_UNITS; do
  unit_state "$u" || no_manager "$u" "nothing was moved and the new service was not started."
  case "$UNIT_ST" in inactive|failed) ;;
    *) echo "   $u is still $UNIT_ST after the stop — nothing was moved and the new service was not started."
       echo "   Stop it (systemctl --user stop $u; a backup: let it finish), check with systemctl --user status $u, then run this again."
       exit 1 ;;
  esac
done

say "4. Env files"
put "$NEW/.env" would_write; echo "   $NEW/.env"
if [ -f "$OLD/.env.mgmt" ]; then put "$NEW/.env.mgmt" rewrite_env "$OLD/.env.mgmt"; echo "   $NEW/.env.mgmt"; fi
echo "   HATCHABOT_DB=$DATA/hatchabot.sqlite"
# `{ grep || true; }`: an env file naming no certificate is the usual case, and
# grep's "no match" under pipefail ended the migration here (found 2026-10-09).
for f in .env .env.mgmt; do [ -f "$NEW/$f" ] || continue; { grep -oE "$NEW/[^ ]*\.(pem|crt|key)" "$NEW/$f" || true; } | while read -r p; do [ -e "$p" ] || echo "   ⚠ $f references $p which does not exist yet — copy it from $OLD before starting"; done; done

say "5. Move data + backups"
if [ ! -f "$DATA/hatchabot.sqlite" ]; then
  mkdir -p "$DATA"
  for s in "" -wal -shm; do [ -e "$OLD_DB$s" ] && mv "$OLD_DB$s" "$DATA/hatchabot.sqlite$s"; done
  ln -s "$DATA/hatchabot.sqlite" "$OLD_DB"   # the old checkout still boots (rollback)
  echo "   $DATA/hatchabot.sqlite (old path is now a symlink to it)"
  for extra in derived-builds mgmt-cli-home; do [ -d "$(dirname "$OLD_DB")/$extra" ] && [ ! -e "$DATA/$extra" ] && mv "$(dirname "$OLD_DB")/$extra" "$DATA/$extra"; done
fi
# The link to the moved backups is made first, beside the old path
# (BACKUPS_LINK), and renamed into it once they are moved: a run stopped
# between the mv and the link left no ~/agentclaw-backups, and a run again
# never made it (HB-1350). The link waiting beside it says they were moved,
# so a run again finishes it.
if [ -d "$HOME/agentclaw-backups" ] && [ ! -L "$HOME/agentclaw-backups" ]; then
  ln -sfn "$HOME/hatchabot-backups" "$BACKUPS_LINK"
  mv "$HOME/agentclaw-backups" "$HOME/hatchabot-backups"
fi
if [ -L "$BACKUPS_LINK" ]; then
  if [ -e "$HOME/agentclaw-backups" ] || [ -L "$HOME/agentclaw-backups" ]; then rm -f "$BACKUPS_LINK"
  else mv -fT "$BACKUPS_LINK" "$HOME/agentclaw-backups"; fi
  echo "   ~/hatchabot-backups (symlink left at ~/agentclaw-backups)"
fi

say "6. systemd units (from deploy/ templates)"
mkdir -p "$UNITS"
SVC_PATH="$NEW/node_modules/.bin:$PATH"
for u in hatchabot.service hatchabot-backup.service hatchabot-mgmt-bot.service hatchabot-backup.timer; do
  [ -f "$NEW/deploy/$u" ] || continue
  [ "$u" = hatchabot-mgmt-bot.service ] && [ ! -f "$NEW/.env.mgmt" ] && continue
  sed -e "s|__HATCHABOT_DIR__|$(esc "$NEW")|g" -e "s|__HATCHABOT_PATH__|$(esc "$SVC_PATH")|g" "$NEW/deploy/$u" > "$UNITS/$u"; echo "   $u"
done
systemctl --user daemon-reload
systemctl --user disable agentclaw.service agentclaw-mgmt-bot.service agentclaw-backup.timer 2>/dev/null || true
NEW_STARTING=1
systemctl --user enable --now hatchabot.service hatchabot-backup.timer
OLD_STOPPED=0  # the new service runs now, on the moved database: starting the old one beside it is no way back
[ -f "$NEW/.env.mgmt" ] && systemctl --user enable --now hatchabot-mgmt-bot.service

say "7. CLI wrapper + config"
mkdir -p "$HOME/.local/bin"
printf '#!/usr/bin/env bash\ncd "%s" && exec node_modules/.bin/tsx src/cli.ts "$@"\n' "$NEW" > "$HOME/.local/bin/hatchabot"; chmod +x "$HOME/.local/bin/hatchabot"
ln -sf "$HOME/.local/bin/hatchabot" "$HOME/.local/bin/agentclaw"
if [ -f "$HOME/.config/agentclaw/env" ] && [ ! -f "$HOME/.config/hatchabot/env" ]; then
  mkdir -p "$HOME/.config/hatchabot"; ( umask 077; sed 's/^AGENTCLAW_/HATCHABOT_/' "$HOME/.config/agentclaw/env" > "$HOME/.config/hatchabot/env" ); chmod 600 "$HOME/.config/hatchabot/env"; echo "   ~/.config/hatchabot/env"
fi

say "8. Health"
PORT="$(envval "$NEW/.env" PORT)"; PORT="${PORT:-8080}"
URL="${HATCHABOT_HEALTH_URL:-http://127.0.0.1:$PORT/}"
WANT="$(node -e 'console.log(require(process.argv[1]).version)' "$NEW/package.json")"
HEALTH_TIMED_OUT=0
for i in $(seq 1 30); do
  PROBE_RC=0
  BODY="$(curl -sk --connect-timeout 3 --max-time 5 "$URL" 2>/dev/null)" || PROBE_RC=$?
  if [ "$PROBE_RC" = 28 ]; then HEALTH_TIMED_OUT=1; fi
  GOT=""
  if [ "$PROBE_RC" = 0 ]; then GOT="$(printf '%s' "$BODY" | grep -oE 'HATCHABOT_VERSION="[^"]+"' | sed -n 1p | cut -d'"' -f2 || true)"; fi
  [ "$GOT" = "$WANT" ] && { echo "   serving Hatchabot $GOT at $URL"; echo; echo "Done. Old checkout kept at $OLD; remove it once you're happy: rm -rf $OLD $UNITS/agentclaw*"; exit 0; }
  sleep 2
done
[ "$HEALTH_TIMED_OUT" != 1 ] || echo "   health checks at $URL timed out (5 seconds per request)"
echo "   not serving $WANT yet — journalctl --user -u hatchabot -n 50"; exit 1
