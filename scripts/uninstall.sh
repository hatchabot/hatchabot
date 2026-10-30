#!/usr/bin/env bash
# Removes a Hatchabot install — the reverse of scripts/setup-host.sh.
#
#   ./scripts/uninstall.sh              # stop it: service, units, CLI link; agents stopped
#   ./scripts/uninstall.sh --purge      # …and the data: volumes, database, images, network
#   ./scripts/uninstall.sh --purge --backups --yes
#   ./scripts/uninstall.sh --installed  # the install the service runs, from another clone
#   ./scripts/uninstall.sh --purge --forget-runners  # …though agents on a runner keep running there
#
# Without --purge NOTHING you would miss is deleted: agent volumes (memory,
# files, members), the database, the backups and the runtime image all stay,
# so re-running setup-host.sh brings the same fleet back. --purge is the clean
# slate, and it asks you to type the word first.
#
# The clone you are standing in is never deleted — the last line tells you how.
# It acts on the install it lives in; when the service runs from another one,
# it refuses unless --installed says to act on that one instead.
set -uo pipefail
cd "$(dirname "$0")/.."
[ -x .node/bin/node ] && PATH="$PWD/.node/bin:$PATH" && export PATH  # a bundle install's own Node (install.sh)
REPO="$(pwd)"

PURGE=0; BACKUPS=0; ASSUME_YES=0; INSTALLED=0; FORGET_RUNNERS=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --backups) BACKUPS=1 ;;
    --installed) INSTALLED=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --forget-runners) FORGET_RUNNERS=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)"; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Which install? The one this script lives in. The unit names the one the
# service runs, and until 2026-10-09 that one was believed: run from a dev or
# test clone, this purged PRODUCTION's containers, volumes, data and .env.
# Now a clone that is not the service's own refuses, naming both, unless
# --installed says to act on the service's install from here.
# The install dir a launchd plist runs from: the job's argument since v2.162.0
# (launchd-plist.sh, XML-escaped), before that baked in as `cd "<dir>"`.
plist_dir() {
  local d
  d="$(sed -n 's/.*<string>hatchabot<\/string><string>\(.*\)<\/string>.*/\1/p' "$1" | sed -n 1p \
    | sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&quot;/"/g' -e "s/&apos;/'/g" -e 's/&amp;/\&/g')"
  [ -n "$d" ] || d="$(sed -n 's/.*cd &quot;\([^&]*\)&quot;.*/\1/p;s/.*cd "\([^"]*\)".*/\1/p' "$1" | sed -n 1p)"
  printf '%s' "$d"
}
UNIT="$HOME/.config/systemd/user/hatchabot.service"
INSTALLED_DIR=""
if [ -f "$UNIT" ]; then
  INSTALLED_DIR="$(sed -n 's/^WorkingDirectory=//p' "$UNIT" | sed -n 1p)"
  INSTALLED_DIR="${INSTALLED_DIR/#\%h/$HOME}"
  # install-service.sh doubles a % in the folder for systemd (audit, 2026-10-29).
  INSTALLED_DIR="$(printf '%s' "$INSTALLED_DIR" | sed 's/%%/%/g')"
elif [ "$(uname -s)" = "Darwin" ]; then
  # launchd has no WorkingDirectory here: the job is given the install dir
  # (plist_dir), so read it back out of whichever plist exists.
  for p in com.hatchabot.control-plane com.agentclaw.control-plane; do
    PL="$HOME/Library/LaunchAgents/$p.plist"
    [ -f "$PL" ] || continue
    INSTALLED_DIR="$(plist_dir "$PL")"
    [ -n "$INSTALLED_DIR" ] && break
  done
fi
# Compared as real paths: a symlinked home or a trailing slash is the same place.
if [ -n "$INSTALLED_DIR" ] && [ -d "$INSTALLED_DIR" ] && [ "$(cd "$INSTALLED_DIR" && pwd -P)" != "$(pwd -P)" ]; then
  if [ "$INSTALLED" != 1 ]; then
    echo "The service runs from $INSTALLED_DIR, but this script is in $REPO."
    echo "Refusing: removing the service here would take the other install's service and agents with it."
    echo "  To remove the install the service runs:  $INSTALLED_DIR/scripts/uninstall.sh   (or add --installed here)"
    echo "  To remove only this clone:                rm -rf \"$REPO\"   (it has no service of its own)"
    exit 2
  fi
  printf '\033[1mNote:\033[0m acting on the install the service runs from, %s (--installed), not this clone.\n' "$INSTALLED_DIR"
  REPO="$(cd "$INSTALLED_DIR" && pwd)"
  [ -x "$REPO/.node/bin/node" ] && PATH="$REPO/.node/bin:$PATH" && export PATH
fi
ENV_DIR="$REPO"

# Where the data lives, read the same way the server reads it.
[ -f "$ENV_DIR/.env" ] && set -a && . "$ENV_DIR/.env" 2>/dev/null; set +a
# A pre-rename .env says AGENTCLAW_*: the server takes each for its HATCHABOT_*
# name unless that is set (src/envCompat.ts), and so does this. Without it an
# AGENTCLAW_DB went unread, and --purge left that database and its agents
# behind but deleted the .env that named them (audit #026).
for v in $(compgen -A variable AGENTCLAW_ 2>/dev/null); do n="HATCHABOT_${v#AGENTCLAW_}"; [ -n "${!n+x}" ] || export "$n=${!v}"; done
BACKUP_DIR="${HATCHABOT_BACKUP_DIR:-$HOME/hatchabot-backups}"
[ -d "$BACKUP_DIR" ] || [ -n "${HATCHABOT_BACKUP_DIR:-}" ] || { [ -d "$HOME/agentclaw-backups" ] && BACKUP_DIR="$HOME/agentclaw-backups"; }   # pre-rename hosts (defaultBackupsDir)
DB_PATH="${HATCHABOT_DB:-$ENV_DIR/data/hatchabot.sqlite}"
[ -f "$DB_PATH" ] || [ -n "${HATCHABOT_DB:-}" ] || { [ -f "$ENV_DIR/data/agentclaw.sqlite" ] && DB_PATH="$ENV_DIR/data/agentclaw.sqlite"; }   # pre-rename default (defaultDbPath)
# Both relative to the install, as the server (run from it) reads them — not
# to wherever this was started: with --installed a relative backup folder was
# the invoking clone's, and --backups deleted that clone's sets (audit #028).
case "$DB_PATH" in /*) ;; *) DB_PATH="$ENV_DIR/$DB_PATH" ;; esac
case "$BACKUP_DIR" in /*) ;; *) BACKUP_DIR="$ENV_DIR/$BACKUP_DIR" ;; esac
DATA_DIR="$(dirname "$DB_PATH")"

PREFIX="${HATCHABOT_PREFIX:-hatchabot}"
# Containers and volumes belong to Hatchabot by name: agentclaw- is the old
# prefix, still worn by agents made before the rename.
# THIS install's agents — the names its database holds — never every
# hatchabot-* container on the machine: a test install beside production used
# to stop (or, with --purge, destroy) production's agents (26th audit). With
# no readable database there is nothing to scope by, and docker is left alone.
# One line per agent, "<container> <volume>", by the provider's own rule
# (src/providers/dockerNames.ts, kept the same by test/dockerNames.test.ts):
# a legacy pre-slug ref (docker://<short id>) is agentclaw-<short> and
# agentclaw-vol-<short>. The bare id was looked up, found nothing, and such
# agents were "none running" while they ran, and orphaned by a purge (HB-0282).
agent_names() {
  [ -f "$DB_PATH" ] && [ -d "$REPO/node_modules/better-sqlite3" ] || return 0
  (cd "$REPO" && node -e '
    const db = require("better-sqlite3")(process.argv[1], { readonly: true });
    const P = process.argv[2];
    for (const r of db.prepare("SELECT runtime_ref FROM agents WHERE runtime_ref IS NOT NULL").all()) {
      const s = String(r.runtime_ref);
      const n = s.replace(/^\w+:\/\//, "");
      if (!s.startsWith("docker://") || n.startsWith(P + "-") || n.startsWith("agentclaw-")) { console.log(n + " " + n + "-vol"); continue; }
      const p = P === "hatchabot" ? "agentclaw" : P;
      console.log(p + "-" + n.slice(0, 12) + " " + p + "-vol-" + n.slice(0, 12));
    }' "$DB_PATH" "$PREFIX" 2>/dev/null)
}
# Its exit status counts too: a database the module cannot open (a Node major
# upgrade breaks the native build) printed nothing, which read as "no agents"
# — "none running" with agents still up, or a purge that orphaned every
# volume (night review, 2026-09-28).
if AGENT_REFS="$(agent_names)"; then DB_READ=1; else DB_READ=0; AGENT_REFS=""; fi
NAMES="$(printf '%s\n' "$AGENT_REFS" | cut -s -d' ' -f1)"
VOL_NAMES="$(printf '%s\n' "$AGENT_REFS" | cut -s -d' ' -f2)"
if [ "$DB_READ" = 0 ]; then
  echo "Cannot read the database at $DB_PATH (node could not open it — after a Node upgrade, run npm rebuild in $REPO), so this install's agents are unknown. Refusing rather than guess."; exit 2
fi
# A database that is there but cannot be read (no node_modules yet) names no
# agents: a purge would then delete the only map from agents to volumes and
# leave every container nameless (30th audit). Refuse, rather than guess.
if [ "$PURGE" = 1 ] && [ -f "$DB_PATH" ] && [ ! -d "$REPO/node_modules/better-sqlite3" ]; then
  echo "Cannot read the database at $DB_PATH (dependencies are not installed: run npm ci in $REPO first), so --purge would orphan every agent's volume. Refusing."; exit 2
fi
# Agents on a runner (a host with a Docker endpoint of its own, its
# settings.dockerHost) live on another machine's daemon, and every docker
# command here asks this one: --purge deleted the only record of them and the
# key to their data, said they were gone, and left them running there (audit
# #037). They are named; --purge refuses while there are any, unless
# --forget-runners says to leave them where they are. Not a DELETED one: the
# app removed its runtime before it said so, and its row is history kept for
# the slug. Counted, a runner's last deleted agent blocked every purge, with
# "Delete them in the app first" for agents already deleted (HB-0345).
runner_agents() {
  [ -f "$DB_PATH" ] && [ -d "$REPO/node_modules/better-sqlite3" ] || return 0
  (cd "$REPO" && node -e '
    const db = require("better-sqlite3")(process.argv[1], { readonly: true });
    const has = (t, c) => !!db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(t, c);
    if (!has("agents", "host_id") || !has("hosts", "settings")) process.exit(0);
    const live = has("agents", "state") ? " WHERE a.state IS NOT \x27DELETED\x27" : "";
    for (const r of db.prepare("SELECT a.name AS agent, h.name AS host, h.settings AS settings FROM agents a JOIN hosts h ON h.id = a.host_id" + live).all()) {
      let s = {}; try { s = JSON.parse(r.settings) || {}; } catch {}
      const at = typeof s.dockerHost === "string" ? s.dockerHost.trim() : "";
      if (at) console.log(`${r.agent} (on ${r.host}: ${at})`);
    }' "$DB_PATH" 2>/dev/null)
}
if RUNNERS="$(runner_agents)"; then :; else
  RUNNERS=""
  if [ "$PURGE" = 1 ]; then echo "Cannot read which machines this install's agents run on ($DB_PATH), so --purge could forget agents running on another machine. Refusing."; exit 2; fi
fi
if [ -n "$RUNNERS" ] && [ "$PURGE" = 1 ] && [ "$FORGET_RUNNERS" != 1 ]; then
  echo "These agents run on another machine (a runner), which this script does not reach:"
  printf '%s\n' "$RUNNERS" | sed 's/^/  · /'
  echo "--purge would delete the only record of them, and the key to their data, and leave them running there."
  echo "  Delete them in the app first (or move them to this machine), then purge again."
  echo "  To purge anyway and leave them running where they are: add --forget-runners."
  exit 2
fi
# Docker must answer before anything is taken away. A daemon that was down (or
# a docker group this session does not have yet) answered every lookup with
# nothing, read as "no agents, no volumes": --purge then deleted the database
# and .env — the only map from the agents to their containers and volumes, and
# the key — said they were all gone, and left them running (audit #024).
DOCKER_OK=0; DOCKER_LOST=0; AGENTS_UP=""; AGENTS_UP_HOW=""
have docker && docker info >/dev/null 2>&1 && DOCKER_OK=1
if [ "$PURGE" = 1 ] && [ -n "$NAMES" ] && [ "$DOCKER_OK" != 1 ]; then
  if have docker; then echo "Docker is not answering (is it running, and is $(id -un) in the docker group?), so this install's"
  else echo "There is no docker command here, so this install's"; fi
  echo "$(wc -w <<<"$NAMES" | tr -d ' ') agents can be neither stopped nor removed. Refusing to --purge: the database and .env"
  echo "are the only record of which containers and volumes are theirs. Start Docker and run this again."
  echo "(If Docker and its volumes are gone from this machine for good, delete $DB_PATH and $ENV_DIR/.env by hand.)"
  exit 2
fi
agent_ids() {
  [ -f "$DB_PATH" ] && [ -d "$REPO/node_modules/better-sqlite3" ] || return 0
  (cd "$REPO" && node -e '
    const db = require("better-sqlite3")(process.argv[1], { readonly: true });
    for (const r of db.prepare("SELECT id FROM agents").all()) console.log(r.id);' "$DB_PATH" 2>/dev/null)
}
# A lookup that fails is not "none": it returns 1, and the caller says so.
containers() {
  [ -n "$NAMES" ] || return 0
  local n
  for n in $NAMES; do docker ps -aq --filter "name=^/$n$" 2>/dev/null || return 1; done
}
# The service containers of THIS install: its agents' doormen (by the agent
# label), their browsers (by the agent container they belong to), and the
# memory search service pair under this install's prefix. Left behind, a
# doorman kept its console port and an embedder its old key, and a reinstall
# failed on both (a MacBook, 2026-09-25). A browser went on running in the
# stopped agent's network, after "no longer running" (HB-0344).
service_containers() {
  for id in $(agent_ids); do docker ps -aq --filter "label=hatchabot.role=doorman" --filter "label=hatchabot.agent=$id" 2>/dev/null; done
  local n
  for n in $NAMES; do docker ps -aq --filter "label=hatchabot.role=browser" --filter "label=hatchabot.browser-of=$n" 2>/dev/null; done
  docker ps -aq --filter "name=^/$PREFIX-embedder$" --filter "name=^/$PREFIX-embed-door$" 2>/dev/null
}
service_networks() {
  for id in $(agent_ids); do docker network ls -q --filter "name=^$PREFIX-ops-$(echo "$id" | tr -cd 'A-Za-z0-9' | cut -c1-12)$" 2>/dev/null; done
  docker network ls -q --filter "name=^$PREFIX-embed$" 2>/dev/null
}
volumes() {
  [ -n "$VOL_NAMES" ] || return 0
  local v
  for v in $VOL_NAMES; do docker volume ls -q --filter "name=^$v$" 2>/dev/null || return 1; done
}
# Which of this install's agents still run (a container name a line); one
# Docker could not be asked about counts as running.
running_agents() {
  local n r
  for n in $NAMES; do r="$(docker ps -q --filter "name=^/$n$" 2>/dev/null)" || r=unknown; [ -z "$r" ] || echo "$n"; done
}
# Containers on this daemon that belong to ANOTHER Hatchabot install: an
# agent (hatchabot.gen), a service container (hatchabot.role) or the name
# prefix, and not one of this install's own. While any is there, the images
# and the agents' network stay — the other install makes its next agents from
# the same tags and on the same network (review, 2026-10-09).
other_installs() {
  local mine; mine="$( { containers; service_containers; } 2>/dev/null | sort -u)"
  { docker ps -aq --filter "label=hatchabot.gen"
    docker ps -aq --filter "label=hatchabot.role"
    docker ps -aq --filter "name=^/hatchabot-"
    docker ps -aq --filter "name=^/agentclaw-"
    [ "$PREFIX" = hatchabot ] || docker ps -aq --filter "name=^/$PREFIX-"; } 2>/dev/null | sort -u | while read -r id; do
      [ -n "$id" ] && ! grep -qxF "$id" <<<"$mine" && echo "$id"
    done
  return 0
}
# The runtime images to delete with --purge: the ones this install's agents and
# classes name, plus the default tag — but never one that ANY container still
# on the daemon uses (a production checkout beside a test one shares
# hatchabot-runtime:latest; purging the test used to untag production's, 30th
# audit). Run after this install's containers are gone. "Uses" is by image ID:
# a container shows the tag it was made from only while the tag still points
# there (a moved tag shows an ID), and one image can wear several tags.
images() {
  local named
  named="$( [ -f "$DB_PATH" ] && [ -d "$REPO/node_modules/better-sqlite3" ] && (cd "$REPO" && node -e '
    const db = require("better-sqlite3")(process.argv[1], { readonly: true });
    const out = new Set();
    for (const t of ["agents", "agent_classes"]) { try { for (const r of db.prepare(`SELECT DISTINCT image FROM ${t} WHERE image IS NOT NULL`).all()) out.add(r.image); } catch {} }
    console.log([...out].join("\n"));' "$DB_PATH" 2>/dev/null) )"
  local others; others="$(other_installs | wc -l | tr -d ' ')"
  if [ "$others" != 0 ]; then
    echo "  keeping the runtime images — $others containers of another Hatchabot install on this machine may need them" >&2
    return 0
  fi
  local ids inuse=""
  ids="$(docker ps -aq 2>/dev/null)"
  # shellcheck disable=SC2086
  [ -n "$ids" ] && inuse="$(docker inspect --format '{{.Image}}' $ids 2>/dev/null | sort -u)"
  { printf '%s\n' "${HATCHABOT_IMAGE:-hatchabot-runtime:latest}"; [ -n "$named" ] && printf '%s\n' "$named"; } \
    | grep -E '^hatchabot-runtime:' | sort -u | while read -r img; do
      [ -n "$img" ] || continue
      id="$(docker image inspect --format '{{.Id}}' "$img" 2>/dev/null)"
      [ -n "$id" ] || continue   # not on this machine: nothing to delete
      grep -qxF "$id" <<<"$inuse" && { echo "  keeping $img — another container on this machine still uses it" >&2; continue; }
      echo "$img"
    done
}

say "This install"
echo "  repo:      $REPO"
echo "  data:      $DATA_DIR $([ -f "$DB_PATH" ] && echo "(database present)" || echo "(no database)")"
echo "  backups:   $BACKUP_DIR $([ -d "$BACKUP_DIR" ] && echo "($(ls -1 "$BACKUP_DIR" 2>/dev/null | wc -l | tr -d ' ') sets)" || echo "(none)")"
if have docker; then
  echo "  agents:    $(containers | wc -l | tr -d ' ') containers, $(volumes | wc -l | tr -d ' ') volumes"
  echo "  images:    $(images | wc -l | tr -d ' ') runtime images"
fi
[ -z "$RUNNERS" ] || echo "  runners:   $(printf '%s\n' "$RUNNERS" | wc -l | tr -d ' ') agents on other machines — not reached from here, they keep running there"
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
# A stop that failed is not a stop. It was ignored: the unit went, the
# database and .env were deleted under the running service, and the last line
# said Hatchabot was no longer running (audit #027). Now a unit or job that
# cannot be seen stopped stays, and nothing else is touched.
STILL_RUNNING=""
if [ "$(uname -s)" = "Darwin" ]; then
  # Both spellings: a host set up before the 2026-09 rename still runs
  # com.agentclaw.* jobs, and looking only for the new names uninstalled
  # nothing at all on it.
  found=0
  for p in com.hatchabot.control-plane com.hatchabot.backup com.agentclaw.control-plane com.agentclaw.backup; do
    PLIST="$HOME/Library/LaunchAgents/$p.plist"
    [ -f "$PLIST" ] || continue
    found=1
    launchctl unload -w "$PLIST" 2>/dev/null || true
    # The job's label is its file's name; launchd still lists a loaded one.
    if launchctl list "$p" >/dev/null 2>&1; then
      echo "  could NOT stop $p (launchctl still lists it) — kept"
      STILL_RUNNING="$STILL_RUNNING $p"; continue
    fi
    rm -f "$PLIST"
    echo "  removed $p"
  done
  [ "$found" = 1 ] || echo "  no launchd jobs found (nothing was installed, or it runs under a different user)"
else
  for unit in hatchabot.service hatchabot-backup.timer hatchabot-backup.service hatchabot-mgmt-bot.service \
              hatchabot-follow-channel.timer hatchabot-follow-channel.service hatchabot-follow-latest.timer hatchabot-follow-latest.service \
              hatchabot-privacy-sync.timer hatchabot-privacy-sync.service \
              agentclaw.service agentclaw-backup.timer agentclaw-backup.service; do
    if systemctl --user list-unit-files "$unit" >/dev/null 2>&1 && [ -f "$HOME/.config/systemd/user/$unit" ]; then
      if ! systemctl --user disable --now "$unit" >/dev/null 2>&1; then
        # Stopped after all (only the disable failed), or not: only inactive
        # or failed counts, not a systemd that could not be asked.
        state="$(systemctl --user is-active "$unit" 2>/dev/null)"
        case "$state" in inactive|failed) ;; *)
          echo "  could NOT stop $unit (systemd says ${state:-nothing}) — kept"
          STILL_RUNNING="$STILL_RUNNING $unit"; continue ;;
        esac
      fi
      rm -f "$HOME/.config/systemd/user/$unit"
      echo "  removed $unit"
    fi
  done
  systemctl --user daemon-reload
  [ -n "$(ls -1 "$HOME/.config/systemd/user" 2>/dev/null | grep -E '^(hatchabot|agentclaw)')" ] \
    && echo "  note: other units remain: $(ls -1 "$HOME/.config/systemd/user" | grep -E '^(hatchabot|agentclaw)' | tr '\n' ' ')"
fi
if [ -n "$STILL_RUNNING" ]; then
  echo
  echo "Stopping$STILL_RUNNING failed, so nothing else was touched: the CLI, the agents, the database and .env are as they were."
  echo "See why (journalctl --user -u <unit>; on a Mac, the job's log), stop it, and run this again."
  exit 1
fi

say "Unlinking the hatchabot CLI…"
# Only THIS install's commands. Any link to a hatchabot CLI used to count as
# ours, and uninstalling a test clone took the production install's hbt with
# it (audit #029).
# The short name first: a link that ends at this install's CLI (npm link's
# chain), or at a link-cli.sh launcher that runs it.
HBT="$(command -v hbt 2>/dev/null || true)"
if [ -n "$HBT" ] && [ -L "$HBT" ]; then
  T="$(readlink -f "$HBT" 2>/dev/null || true)"
  if [ -n "$T" ] && { [ "$T" = "$(readlink -f "$REPO/bin/hatchabot.mjs" 2>/dev/null)" ] || grep -qF "\"$REPO/bin/hatchabot.mjs\"" "$T" 2>/dev/null; }; then
    rm -f "$HBT" && echo "  removed hbt"
  fi
fi
# A bundle install's commands are two launchers link-cli.sh wrote into
# ~/.local/bin (it has no npm to link with); they outlived the uninstall
# (review, 2026-10-09). Only the ones that run THIS install.
# (The folder as link-cli.sh writes it inside the launcher's quotes: a $, `, "
# or \ escaped.)
REPO_IN_LAUNCHER="$(printf '%s' "$REPO" | sed -e 's/[\\$`"]/\\&/g')"
for name in hatchabot hbt; do
  L="$HOME/.local/bin/$name"
  [ -f "$L" ] && [ ! -L "$L" ] && grep -q 'written by scripts/link-cli.sh' "$L" 2>/dev/null && grep -qF "\"$REPO_IN_LAUNCHER/bin/hatchabot.mjs\"" "$L" 2>/dev/null \
    && rm -f "$L" && echo "  removed ~/.local/bin/$name"
done
# The global `hatchabot` npm link: npm link made it a link to the install
# folder, so it is this one's only when it leads here.
G="$(npm root -g 2>/dev/null || true)"
if [ -n "$G" ] && [ -L "$G/hatchabot" ]; then
  if [ "$(readlink -f "$G/hatchabot")" = "$(cd "$REPO" && pwd -P)" ]; then
    npm unlink -g hatchabot >/dev/null 2>&1 && echo "  unlinked" || echo "  could not unlink it: run  npm unlink -g hatchabot"
  else
    echo "  kept the global hatchabot command: it runs another install ($(readlink -f "$G/hatchabot"))"
  fi
else
  echo "  (was not linked)"
fi
# The CLI's token, and the channel file installs before v2.169.0 kept, belong
# to the USER, not this install (a production checkout beside a test one
# shares them): only --purge takes them. This install's own channel
# (data/channel, HB-0235) goes with a purge too.
if [ "$PURGE" = 1 ]; then
  [ -f "$HOME/.config/hatchabot/env" ] && rm -f "$HOME/.config/hatchabot/env" && echo "  removed ~/.config/hatchabot/env"
  [ -f "$HOME/.config/hatchabot/channel" ] && rm -f "$HOME/.config/hatchabot/channel" && echo "  removed the channel pin"
  [ -f "$REPO/data/channel" ] && rm -f "$REPO/data/channel" && echo "  removed this install's channel"
fi

if have docker; then
  # STOPPED, not removed. The control plane only mends states — it never
  # re-creates a runtime on its own — so removing containers would leave every
  # agent needing a Rebuild after a reinstall, which is not "nothing you would
  # miss is deleted". --purge removes them below.
  say "Stopping agents…"
  # The doormen, the browsers and the memory search service hold nothing of
  # the agents' (a rebuild or the next start makes them afresh), so they go
  # even without --purge: a reinstall must not meet them on its ports. First:
  # a browser lives in its agent's network.
  SIDS="$(service_containers | sort -u)"
  if [ -n "$SIDS" ]; then
    # shellcheck disable=SC2086
    docker rm -f $SIDS >/dev/null 2>&1 && echo "  removed $(echo "$SIDS" | wc -l | tr -d ' ') service containers (doormen, browsers, memory search)"
  fi
  if ! CIDS="$(containers)"; then
    DOCKER_LOST=1
    echo "  could NOT ask Docker for this install's agents, so none was stopped (docker ps -a lists them)"
  elif [ -n "$CIDS" ]; then
    # A stop Docker refused is not a stop: it was ignored, and the last line
    # said Hatchabot was no longer running, exit 0, with the agent up (HB-0343).
    # shellcheck disable=SC2086
    if ERR="$(docker stop $CIDS 2>&1 >/dev/null)"; then
      echo "  stopped $(echo "$CIDS" | wc -l | tr -d ' ') containers (kept, with their volumes)"
    else
      AGENTS_UP="$(running_agents)"
      if [ -n "$AGENTS_UP" ]; then
        echo "  could NOT stop $(echo "$AGENTS_UP" | wc -l | tr -d ' ') of $(echo "$CIDS" | wc -l | tr -d ' ') containers: ${ERR:-docker refused}"
        AGENTS_UP_HOW="Docker would not stop them"
      else
        echo "  stopped $(echo "$CIDS" | wc -l | tr -d ' ') containers (kept, with their volumes)"
      fi
    fi
  else
    echo "  none running"
  fi
fi

if [ "$PURGE" = 1 ]; then
  if have docker; then
    say "Removing agent containers…"
    if ! CIDS="$(containers)"; then DOCKER_LOST=1; echo "  could NOT ask Docker for them"
    elif [ -z "$CIDS" ]; then AGENTS_UP=""
    else
      # shellcheck disable=SC2086
      if docker rm -f $CIDS >/dev/null 2>&1; then
        echo "  removed $(echo "$CIDS" | wc -l | tr -d ' ') containers"; AGENTS_UP=""
      else
        AGENTS_UP="$(running_agents)"; AGENTS_UP_HOW="Docker would not remove them"
        [ -z "$AGENTS_UP" ] || echo "  could NOT remove $(echo "$AGENTS_UP" | wc -l | tr -d ' ') running containers"
      fi
    fi
    say "Deleting agent volumes…"
    VOLS="$(volumes)" || { DOCKER_LOST=1; echo "  could NOT ask Docker for them"; }
    if [ -n "$VOLS" ]; then
      VOLS_GONE=0
      for v in $VOLS; do
        # Docker refuses a volume any container references, even one that
        # never started: a volume one-shot whose client was killed stayed
        # 'created' (review, 2026-09-29). This install's agents are gone by
        # now, so what still holds one of their volumes is such a one-shot —
        # ours by label, or one that never ran or has finished.
        LEFT="$( { docker ps -aq --filter "volume=$v" --filter "label=hatchabot.oneshot=$PREFIX"
                   docker ps -aq --filter "volume=$v" --filter status=created --filter status=exited; } 2>/dev/null | sort -u)"
        # shellcheck disable=SC2086
        [ -n "$LEFT" ] && docker rm -f $LEFT >/dev/null 2>&1
        # Said, not hidden: the database that maps agents to volumes goes
        # next, and a silent failure left their data behind unannounced.
        if ERR="$(docker volume rm "$v" 2>&1 >/dev/null)"; then
          VOLS_GONE=$((VOLS_GONE + 1))
        else
          VOLS_LEFT="${VOLS_LEFT:-}${VOLS_LEFT:+ }$v"
          echo "  could NOT remove volume $v: ${ERR:-docker refused}"
        fi
      done
      echo "  removed $VOLS_GONE volumes"
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
    # The agents' network by the name this install used (its .env may name
    # another), and never while another install's agents may be on it.
    NET="${HATCHABOT_AGENT_NETWORK:-hatchabot-agents}"
    case "$NET" in bridge|host|none|"") ;; *)
      if [ -n "$(other_installs)" ]; then echo "  kept the $NET network — another Hatchabot install on this machine uses it"
      else docker network rm "$NET" >/dev/null 2>&1 && echo "  removed the $NET network"; fi ;;
    esac
    NIDS="$(service_networks | sort -u)"
    # shellcheck disable=SC2086
    [ -n "$NIDS" ] && docker network rm $NIDS >/dev/null 2>&1 && echo "  removed $(echo "$NIDS" | wc -l | tr -d ' ') service networks"
  fi
  # Docker stopped answering part-way: what it did not list may still be
  # there, and the database and .env are the map to it (audit #024).
  if [ "$DOCKER_LOST" = 1 ]; then
    echo
    echo "Docker stopped answering part-way, so some of this install's containers or volumes may still be there."
    echo "Kept the database ($DB_PATH) and $ENV_DIR/.env: they are the map to them. Start Docker and run this again."
    exit 1
  fi
  # Nor while an agent still runs: they are its map and its key (HB-0343).
  if [ -n "$AGENTS_UP" ]; then
    echo
    echo "These agents of this install are still running ($AGENTS_UP_HOW):"
    for n in $AGENTS_UP; do echo "  · $n"; done
    echo "Kept the database ($DB_PATH) and $ENV_DIR/.env: they are the map to them. See why (docker inspect <name>), then run this again."
    exit 1
  fi
  say "Deleting local state…"
  # The backups first, and only Hatchabot's own sets: the folder may be a NAS
  # mount other machines back up into (backup-volumes.sh prunes only its dated
  # sets for that reason), and --backups used to rm -rf all of it (review,
  # 2026-10-09). The folder goes only when that leaves it empty.
  if [ "$BACKUPS" = 1 ] && [ -d "$BACKUP_DIR" ]; then
    # Nor another install's sets, when two share the folder: a set names the
    # install that made it (.backup-owner), or an older one the key it saved,
    # fingerprinted as backup-volumes.sh's key_owner does (HB-0280).
    key_owner() {
      node -e '
      const fs = require("node:fs");
      const { parseEnv } = require("node:util");
      const saved = process.argv[1];
      const key = saved ? (() => { const f = fs.existsSync(saved) ? parseEnv(fs.readFileSync(saved, "utf8")) : {}; return f.HATCHABOT_SECRET_KEY ?? f.AGENTCLAW_SECRET_KEY; })()
        : process.env.HATCHABOT_SECRET_KEY ?? process.env.AGENTCLAW_SECRET_KEY;
      if (key) process.stdout.write(require("node:crypto").createHash("sha256").update("hatchabot-backup-owner\0" + key).digest("hex").slice(0, 16));' "${1:-}" 2>/dev/null || true
    }
    OWNER="$(key_owner)"
    SETS=0; THEIRS=0
    for d in "$BACKUP_DIR"/20??-??-??; do
      [ -d "$d" ] && { [ -f "$d/backup-status.json" ] || [ -f "$d/hatchabot.sqlite" ]; } || continue
      so="$(cat "$d/.backup-owner" 2>/dev/null || true)"
      if [ -z "$so" ] && [ -n "$OWNER" ] && [ -f "$d/secret-key.env" ]; then so="$(key_owner "$d/secret-key.env")"; fi
      if [ -n "$OWNER" ] && [ -n "$so" ] && [ "$so" != "$OWNER" ]; then THEIRS=$((THEIRS + 1)); continue; fi
      rm -rf "$d" && SETS=$((SETS + 1))
    done
    echo "  removed $SETS backup sets from $BACKUP_DIR"
    [ "$THEIRS" = 0 ] || echo "  kept $THEIRS sets another Hatchabot install made there"
    if rmdir "$BACKUP_DIR" 2>/dev/null; then echo "  removed $BACKUP_DIR (empty now)"
    else echo "  kept $BACKUP_DIR itself: it holds more than Hatchabot's backup sets"; fi
  fi
  # A backup folder inside the data folder is not part of the data: removing
  # the data folder whole took the backups with it, --backups or not.
  DB_ONLY=0; KEEP_TOP=""
  if [ -d "$BACKUP_DIR" ] && [ -d "$DATA_DIR" ]; then
    B="$(cd "$BACKUP_DIR" && pwd -P)"; D="$(cd "$DATA_DIR" && pwd -P)"
    case "$D/" in "$B/"*) DB_ONLY=1 ;; esac                               # the data folder IS the backup folder, or inside it
    case "$B" in "$D/"*) KEEP_TOP="${B#"$D/"}"; KEEP_TOP="${KEEP_TOP%%/*}" ;; esac   # the backups are inside the data folder
  fi
  # The whole directory only when it is Hatchabot's own (the install's data/
  # or a folder named hatchabot-data, as docs/releasing.md sets one up); a
  # database placed elsewhere (a home directory, a NAS folder) loses only its
  # own files (26th audit). By the folder's own name, not anywhere in its
  # path: a database in .../hatchabot-data-old/shared/ took the whole shared
  # folder with it (audit #025).
  case "$DATA_DIR" in
    "$ENV_DIR/data"|*/hatchabot-data|*/agentclaw-data)
      if [ "$DB_ONLY" = 1 ]; then
        rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm" && echo "  removed the database in $DATA_DIR (it is the backup folder too, so the folder stays)"
      elif [ -n "$KEEP_TOP" ]; then
        for e in "$D"/* "$D"/.[!.]* "$D"/..?*; do
          { [ -e "$e" ] || [ -L "$e" ]; } && [ "$e" != "$D/$KEEP_TOP" ] && rm -rf "$e"
        done
        echo "  removed $DATA_DIR, except $KEEP_TOP/ — it holds the backups ($BACKUP_DIR)"
      else
        rm -rf "$DATA_DIR" && echo "  removed $DATA_DIR"
      fi ;;
    *) rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm" && echo "  removed the database in $DATA_DIR (the folder is not Hatchabot's own, so it stays)" ;;
  esac
  [ -f "$ENV_DIR/.env" ] && rm -f "$ENV_DIR/.env" && echo "  removed $ENV_DIR/.env"
  if [ "$BACKUPS" != 1 ] && [ -d "$BACKUP_DIR" ]; then
    echo "  kept $BACKUP_DIR (pass --backups to delete its backup sets too)"
  fi
fi

say "Done."
if [ -n "$AGENTS_UP" ]; then
  echo "Hatchabot's service is removed, but these agents of this install are still running ($AGENTS_UP_HOW):"
  for n in $AGENTS_UP; do echo "  · $n"; done
  echo "See why (docker inspect <name>, and the Docker daemon's log), then: docker stop <name>"
else
  echo "Hatchabot is no longer running or installed on this machine."
fi
[ "$DOCKER_LOST" = 0 ] || echo "But Docker did not answer, so this install's agents were not stopped: see docker ps."
if [ "$PURGE" = 1 ] && [ -n "${VOLS_LEFT:-}" ]; then
  echo "Its agents and database are gone, but these agent volumes are NOT — their data is still on this machine:"
  for v in $VOLS_LEFT; do echo "  · $v"; done
  echo "See what holds one:  docker ps -a --filter volume=<name>   then:  docker volume rm <name>"
elif [ "$PURGE" = 1 ] && [ -n "$RUNNERS" ]; then
  echo "Its agents on this machine, their volumes and the database are gone. These still run on their runners (--forget-runners), no longer managed from anywhere:"
  printf '%s\n' "$RUNNERS" | sed 's/^/  · /'
  echo "On each runner: docker ps -a, then docker rm -f <container> and docker volume rm <container>-vol."
elif [ "$PURGE" = 1 ]; then
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
  [ -z "$RUNNERS" ] || { echo "NOT STOPPED — these run on other machines (runners), which this script does not reach:"; printf '%s\n' "$RUNNERS" | sed 's/^/  · /'; echo; }
  echo "For a clean slate instead:  ./scripts/uninstall.sh --purge --backups"
fi
echo "The clone itself is untouched. To remove it:  rm -rf \"$REPO\""
echo "Telegram bots are not deletable from here: @BotFather → /mybots → /deletebot."
# A purge that left volumes behind did not finish its job, nor did a stop
# Docker did not answer or refused: say so to a caller too.
[ -z "${VOLS_LEFT:-}" ] && [ "$DOCKER_LOST" = 0 ] && [ -z "$AGENTS_UP" ] || exit 1
