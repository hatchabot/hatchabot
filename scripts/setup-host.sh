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
[ -x "$(dirname "$0")/../.node/bin/node" ] && PATH="$(cd "$(dirname "$0")/.." && pwd)/.node/bin:$PATH" && export PATH  # a bundle install's own Node (install.sh)
umask 077   # .env and ~/.config/hatchabot/env hold secrets: never created wider than 0600
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# .env read as the service reads it: on Linux by systemd's EnvironmentFile
# rules, on a Mac as its launchd job sources it (env_named; the settings
# below say more).
# systemd_major FILE: the first number of `systemctl --version`, in
# SYSTEMD_MAJOR, for the reader of systemd's rules (`systemd`, in node). From
# v254 a line after a comment that ends in a backslash is a line of its own;
# before, it went on the comment. Read always the old way, `# C:\data\` and
# then a HATCHABOT_DB line named the database to systemd 254 and nothing here
# (HB-1457). Asked once, and only of a FILE with a backslash at the end of a
# line, the one place the two differ. With no systemctl to ask, empty: read as
# v254 reads, as no systemd reads .env there (on Linux Hatchabot runs as a
# systemd unit; a Mac's launchd job sources .env with bash, which reads that
# line too), and that is the rule of every systemd since 2023 and of
# Hatchabot's own readers. Never taken from the environment: one a caller
# exported chose the rule, so it is unset here, before any reading. The same
# in every script that reads .env so (test/backupKeyLine.test.ts, READERS).
unset SYSTEMD_MAJOR
systemd_major() {
  [ -z "${SYSTEMD_MAJOR+x}" ] || return 0
  LC_ALL=C grep -q -e '\\$' -e $'\\\\\r' "$1" 2>/dev/null || return 0
  SYSTEMD_MAJOR="$( { systemctl --version 2>/dev/null || true; } | sed -n '1s/^[^0-9]*\([0-9][0-9]*\).*/\1/p')"
}
env_named() {
  # ENV_READ: 1 once .env was read through (a node that failed reads nothing;
  # with no node on Linux, only what bash reads as systemd does, below).
  # A HATCHABOT_ name is read under its name from before the rename too
  # (AGENTCLAW_), which the service takes when the new one is not set
  # (applyLegacyEnv): a pre-rename AGENTCLAW_IMAGE was the service's image,
  # and the upgrade's and setup's was the default (HB-1379).
  local kv k
  local -a names=()
  for k in "$@"; do
    names+=("$k")
    case "$k" in
      HATCHABOT_*) names+=("AGENTCLAW_${k#HATCHABOT_}") ;;
    esac
  done
  ENV_READ=''
  systemd_major .env
  for k in "${names[@]}"; do printf -v "ENV_$k" '%s' ''; printf -v "ENVSET_$k" '%s' ''; done
  # The reading, in the < <( ... ) below, says what it is here: bash 3.2
  # finds where one ends by its quotes and parentheses, comments in it too
  # (review of HB-1529).
  # - On a Mac, as the launchd job sources it (launchd-plist.sh): by
  #   /bin/bash, with launchd's few settings and nothing on its input; the
  #   PATH is this shell's, not the job's own (the plist's). In a subshell of
  #   this one it had the caller's whole environment, its shell's variables
  #   and its input (HB-1381).
  # - With no node to ask (a restart from cron or a bare ssh, with an nvm
  #   node off its PATH): what bash reads as systemd does, NAME=value with
  #   spaces or tabs around the = (only those: systemd keeps a form feed or a
  #   vertical tab) and the value whole, or quoted whole, on its line. A file
  #   with a carriage return or a backslash at a line's end, or with a value
  #   on any line that opens a quote it does not close on that line (systemd
  #   reads on into the lines after it, and they are no settings of their
  #   own), is left unread, and so is a value asked for that is quoted any
  #   other way or has a backslash in it. Unread whenever node was not
  #   there, a restart asked plain http on port 8080, and failed a listener
  #   the sed it replaced had found (review of HB-1529).
  # - Otherwise by systemd's rules, in node.
  while IFS= read -r -d '' kv; do
    k="${kv%%=*}"
    [ "$k" != . ] || { ENV_READ=1; continue; }
    printf -v "ENV_$k" '%s' "${kv#*=}"; printf -v "ENVSET_$k" '%s' 1
  done < <(
    if [ "$(uname -s)" = Darwin ]; then
      set +eu
      lj=(HOME="$HOME" PATH="$PATH")
      for k in USER LOGNAME SHELL TMPDIR; do [ -z "${!k:-}" ] || lj+=("$k=${!k}"); done
      env -i "${lj[@]}" /bin/bash -c 'for k in "$@"; do unset "$k"; done; set -a; . ./.env >/dev/null 2>&1; set +a
        for k in "$@"; do [ -z "${!k+x}" ] || printf "%s=%s\0" "$k" "${!k}"; done; printf ".=\0"' launchd-job "${names[@]}" </dev/null
    elif ! command -v node >/dev/null 2>&1; then
      set +e
      sp=$' \t'
      [ -r .env ] || exit 0
      LC_ALL=C grep -q -e $'\r' -e '\\$' .env 2>/dev/null && exit 0
      while IFS= read -r kv || [ -n "$kv" ]; do
        kv="${kv#"${kv%%[!$sp]*}"}"
        [ -n "$kv" ] && [ "${kv:0:1}" != "#" ] && [ "${kv:0:1}" != ";" ] && [[ "${kv:1}" == *=* ]] || continue
        kv="${kv:1}"; kv="${kv#*=}"; kv="${kv#"${kv%%[!$sp]*}"}"; kv="${kv%"${kv##*[!$sp]}"}"
        [[ "$kv" == [\'\"]* ]] || continue
        [[ "$kv" == \'*\' && "${kv:1:${#kv}-2}" != *\'* ]] || [[ "$kv" == \"*\" && "${kv:1:${#kv}-2}" != *[\"\\]* ]] || exit 0
      done < .env
      for k in "${names[@]}"; do
        kv="$(LC_ALL=C grep -E "^[$sp]*$k[$sp]*=" .env 2>/dev/null | tail -n 1)"
        [ -n "$kv" ] || continue
        kv="${kv#*=}"; kv="${kv#"${kv%%[!$sp]*}"}"; kv="${kv%"${kv##*[!$sp]}"}"
        if [[ "$kv" == \'*\' && "${kv:1:${#kv}-2}" != *\'* ]]; then kv="${kv:1:${#kv}-2}"
        elif [[ "$kv" == \"*\" && "${kv:1:${#kv}-2}" != *[\"\\]* ]]; then kv="${kv:1:${#kv}-2}"
        elif [[ "$kv" == [\'\"]* || "$kv" == *\\* ]]; then exit 0
        fi
        printf '%s=%s\0' "$k" "$kv"
      done
      printf '.=\0'
    else
      node -e '
    const systemd = (t, ver) => {
      // ver: the first number of `systemctl --version` (systemd_major). Before v254 a comment ending in a
      // backslash went on over the next line; from v254, and with no systemctl to ask, that line is read.
      const joins = Number(ver) > 0 && Number(ver) < 254;
      const out = {}; let st = "prekey", k = "", v = "", lw = -1;
      // lw: where the run of spaces and tabs at the end of the value starts (last_value_whitespace in
      // systemd), the only part trimmed: an escaped space or tab is kept, as systemd keeps it.
      const done = () => { if (k) out[k] = lw >= 0 ? v.slice(0, lw) : v; k = ""; v = ""; lw = -1; st = "prekey"; };
      for (const c of t) {
        const nl = c === "\n" || c === "\r", ws = c === " " || c === "\t" || nl;
        if (st === "prekey") { if (c === "#" || c === ";") st = "comment"; else if (!ws) { k = c; st = "key"; } }
        else if (st === "comment") { if (c === "\\") st = "commentesc"; else if (nl) st = "prekey"; }
        else if (st === "commentesc") st = nl && !joins ? "prekey" : "comment";
        else if (st === "key") { if (nl) { k = ""; st = "prekey"; } else if (c === "=") { k = k.replace(/[ \t]+$/, ""); st = "prevalue"; } else k += c; }
        else if (st === "prevalue") { if (nl) done(); else if (c === "\x27") st = "single"; else if (c === "\"") st = "double"; else if (c === "\\") st = "esc"; else if (!ws) { v += c; st = "value"; } }
        else if (st === "value") { if (nl) done(); else if (c === "\\") { st = "esc"; lw = -1; } else { if (c !== " " && c !== "\t") lw = -1; else if (lw < 0) lw = v.length; v += c; } }
        else if (st === "esc") { st = "value"; if (!nl) v += c; }
        else if (st === "single") { if (c === "\x27") st = "prevalue"; else v += c; }
        else if (st === "double") { if (c === "\"") st = "prevalue"; else if (c === "\\") st = "doubleesc"; else v += c; }
        else if (st === "doubleesc") { st = "double"; if (c !== "\n") v += "\"\\`$".includes(c) ? c : "\\" + c; }
      }
      // The end of the file ends a value as a newline does, quoted or escaped as far as it went, as
      // systemd keeps it: a quote never closed, or a backslash last, lost its key here.
      if (["prevalue", "value", "esc", "single", "double", "doubleesc"].includes(st)) done();
      return out;
    };
    const out = systemd(require("node:fs").readFileSync(".env", "utf8"), process.argv[1]);
    for (const k of process.argv.slice(2)) if (Object.prototype.hasOwnProperty.call(out, k)) process.stdout.write(k + "=" + out[k] + "\0");
    process.stdout.write(".=\0");' "${SYSTEMD_MAJOR:-}" "${names[@]}" 2>/dev/null || true
    fi
  )
  for k in "$@"; do
    case "$k" in
      HATCHABOT_*) ;;
      *) continue ;;
    esac
    kv="ENVSET_$k"; [ -z "${!kv}" ] || continue
    kv="ENVSET_AGENTCLAW_${k#HATCHABOT_}"; [ -n "${!kv}" ] || continue
    kv="ENV_AGENTCLAW_${k#HATCHABOT_}"
    printf -v "ENV_$k" '%s' "${!kv}"; printf -v "ENVSET_$k" '%s' 1
  done
}
# service_port VALUE: the port the service listens on with VALUE as its PORT,
# read as the service reads it (Number(), as doctor's servicePort): 8080 when
# it is unset, empty or no number. On Linux a " # note" after the value is
# part of it, as systemd keeps it: the service then listens on 8080, as for
# no PORT (before 2.193.0 it did not start), and a URL with that value in it
# is none at all (HB-1529). With no node to ask, digits alone are a port,
# with the ASCII white space Number takes off around them taken off too (a
# form feed systemd keeps; review of HB-1529). The same in each script that
# asks the listener (test/doctorServiceTargets.test.ts).
service_port() {
  local n ws=$' \t\n\v\f\r'
  node -e 'process.stdout.write(String(Number(process.argv[1]) || 8080))' -- "$1" 2>/dev/null && return 0
  n="${1#"${1%%[!$ws]*}"}"; n="${n%"${n##*[!$ws]}"}"
  case "$n" in
    ''|*[!0-9]*) echo 8080 ;;
    *)
      n="${n#"${n%%[!0]*}"}"   # the zeros it starts with dropped, as Number reads them
      echo "${n:-8080}" ;;
  esac
}

say "Checking prerequisites…"
command -v docker >/dev/null || { echo "docker is required — install Docker Engine first."; exit 1; }
# The Docker daemon the service will use is the one .env names (a tenant's
# rootless daemon on a shared host), or will name once HATCHABOT_SETUP_ENV is
# written to a new .env: that is the one checked, and the one the runtime
# image is looked for and fetched on below. Looked for on this shell's daemon,
# an image there read as "already present" while the tenant's daemon had none
# (audit #040); checked on it, a re-run on such an install stopped here when
# this shell had no daemon of its own (HB-1059). The last line wins, as
# systemd's EnvironmentFile reads it.
# Read as the service reads it (env_named, node on Linux): by sed, `DOCKER_HOST =
# …` and a line with CRLF were not the service's daemon (HB-1529). The lines
# HATCHABOT_SETUP_ENV gives the new .env are read from a file of their own,
# as they will be once written there.
command -v node >/dev/null || { echo "node is required — install Node.js 22+."; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || { echo "Node 22+ required (found $(node --version))."; exit 1; }
if [ -f .env ]; then NAMED_IN=.env; env_named DOCKER_HOST
else
  NAMED_IN=HATCHABOT_SETUP_ENV; SETUP_DIR="$PWD"
  ENV_TMP="$(mktemp -d)" && printf '%s\n' "${HATCHABOT_SETUP_ENV:-}" > "$ENV_TMP/.env" || { echo "Could not write a temporary file to read HATCHABOT_SETUP_ENV from (a full disk?), so nothing was set up."; exit 1; }
  CDPATH= cd -- "$ENV_TMP"; env_named DOCKER_HOST; CDPATH= cd -- "$SETUP_DIR"; rm -rf "$ENV_TMP"
fi
[ -n "$ENV_READ" ] || echo "⚠ Could not read $NAMED_IN as the service reads it, so this shell's Docker daemon is checked, which may not be the service's."
if [ -n "$ENVSET_DOCKER_HOST" ]; then
  DH="$ENV_DOCKER_HOST"
  if [ -n "$DH" ]; then export DOCKER_HOST="$DH"; else unset DOCKER_HOST; fi
  docker info >/dev/null 2>&1 || { echo "The Docker daemon $NAMED_IN names (DOCKER_HOST=$DH) is not reachable — start it, or correct DOCKER_HOST in $NAMED_IN, then re-run."; exit 1; }
else
  docker info >/dev/null 2>&1 || { echo "docker is installed but not usable by this user (try: sudo usermod -aG docker \$USER, then re-login)."; exit 1; }
fi

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
      # Unattended (HATCHABOT_YES=1, or no terminal: `bash -s` with the script
      # on stdin) takes the recommended answer — a `read` there ate the
      # caller's next line as the answer (30th audit).
      if [ "${HATCHABOT_YES:-}" = 1 ] || [ ! -t 0 ]; then SIGNIN=1; else
      echo "How will people sign in?"
      echo "  1) An account for each person — their own agents, and a forgotten"
      echo "     password is a link you send them  (recommended)"
      echo "  2) One shared password"
      read -r -p "Choose [1]: " SIGNIN
      SIGNIN="${SIGNIN:-1}"; fi ;;
    *) echo "HATCHABOT_SETUP_SIGNIN must be accounts or password."; exit 1 ;;
  esac
  PW=""
  if [ "$SIGNIN" = "2" ]; then
    if [ -n "${HATCHABOT_SETUP_PASSWORD:-}" ]; then PW="$HATCHABOT_SETUP_PASSWORD"; else read -r -s -p "Choose an app password (what you'll type to open the web app): " PW; echo; fi
    [ -n "$PW" ] || { echo "Password cannot be empty."; exit 1; }
    # systemd's EnvironmentFile and the shell read a quoted apostrophe
    # differently, so a password holding one never matched on Linux.
    case "$PW" in
      *"'"*) echo "Please choose a password without an apostrophe (')."; exit 1 ;;
    esac
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
# Every setting written out: what's set stays in force, the rest listed with
# its default (src/config/envFile.ts). Hatchabot does this again at each start.
./node_modules/.bin/tsx scripts/env-sync.ts .env >/dev/null || say "Couldn't list every setting in .env yet; Hatchabot will when it starts."

# The settings below, read from .env as the service reads it: on Linux by
# systemd's EnvironmentFile rules (the reader is backup-volumes.sh's, held the
# same by test/backupKeyLine.test.ts), where spaces around the = count and a
# " # ..." after a value is part of it; on a Mac as its launchd job reads it,
# sourced by bash (launchd-plist.sh), in a subshell, where only NAME=value
# sets it. Read by sed with a comment taken off, the image, the mirror and the
# CLI's address could be what the service never got (review of HB-1109 and
# HB-1210). Each name .env sets is ENV_<name>, with ENVSET_<name>=1 (env_named,
# at the top).
env_named HATCHABOT_IMAGE HATCHABOT_IMAGE_REGISTRY PORT HATCHABOT_TLS_CERT HATCHABOT_BIND

# On the daemon .env names (DOCKER_HOST, set under the prerequisites above),
# and the image the service runs agents on and the mirror it pulls from as
# .env names them (HATCHABOT_IMAGE, HATCHABOT_IMAGE_REGISTRY); with none, what
# the environment has, as upgrade.sh has it. hatchabot-runtime:latest was
# looked at whatever the service used, so setup fetched or kept the default
# image while the service ran agents on another (HB-1210).
# build-runtime-image.sh, given them, fetches into that image's repository
# from that mirror.
for v in HATCHABOT_IMAGE HATCHABOT_IMAGE_REGISTRY; do
  set_in="ENVSET_$v"; val="ENV_$v"
  [ -n "${!set_in}" ] || continue
  if [ -n "${!val}" ]; then export "$v=${!val}"; else unset "$v"; fi
done
IMAGE="${HATCHABOT_IMAGE:-hatchabot-runtime:latest}"
# A fetch moves :latest of the image's repository (build-runtime-image.sh,
# REPO), so that is the one looked at. One named by another tag (or a digest)
# is one the owner pinned, which no fetch moves (upgrade.sh leaves it).
IMAGE_REPO="$(printf '%s' "$IMAGE" | sed 's/:[^:/]*$//')"
LATEST="${HATCHABOT_IMAGE_REPO:-$IMAGE_REPO}:latest"
if [ "$IMAGE" != "$IMAGE_REPO" ] && [ "$IMAGE" != "$IMAGE_REPO:latest" ] || [ "$IMAGE" != "${IMAGE%@*}" ]; then
  # A pin of an OpenClaw version, in the repository the build writes to, is
  # that version's own image: fetched as a candidate (it pulls the published
  # image, or builds it), which moves no :latest. Missing, agents could not
  # start until the owner fetched it by hand (HB-1376). Any other pin (a
  # digest, packages, another name) is not guessed at: pulling a name could
  # reach a registry squat or a download of gigabytes.
  PIN_VERSION="${IMAGE#"$IMAGE_REPO":}"
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    say "The runtime image is pinned to $IMAGE (HATCHABOT_IMAGE) — keeping it."
  elif [ "$IMAGE" = "${IMAGE%@*}" ] && [ "${HATCHABOT_IMAGE_REPO:-$IMAGE_REPO}" = "$IMAGE_REPO" ] && [[ "$PIN_VERSION" =~ ^[0-9]{4}\.[0-9]+\.[0-9]+(-[0-9]+)?$ ]]; then
    say "The runtime image .env pins, $IMAGE (HATCHABOT_IMAGE), is not on this machine — fetching OpenClaw $PIN_VERSION's image (downloads it, or builds it if none is published)…"
    OPENCLAW_VERSION="$PIN_VERSION" NO_LATEST=1 ./scripts/build-runtime-image.sh || true
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "⚠ Could not fetch $IMAGE now: agents cannot start until it is here. Run OPENCLAW_VERSION=$PIN_VERSION NO_LATEST=1 ./scripts/build-runtime-image.sh later, or take HATCHABOT_IMAGE out of .env for this release's default."
    fi
  else
    say "⚠ The runtime image .env pins, $IMAGE (HATCHABOT_IMAGE), is not on this machine, and setup fetches a pin only when it is an OpenClaw version's own image: agents cannot start until it is here (docker pull $IMAGE), or HATCHABOT_IMAGE goes from .env for this release's default."
  fi
elif docker image inspect "$LATEST" >/dev/null 2>&1; then
  # An existing install may have promoted a NEWER image to :latest — a default
  # build here would silently demote it (learned the hard way). An OLDER one
  # (a reinstall on a box that kept its images) is brought up to this
  # release's default, the way an upgrade does (2026-09-25).
  WANT="$(sed -n 's/^ARG OPENCLAW_VERSION=//p' docker/Dockerfile.runtime | sed -n 1p)"
  HAVE="$(docker image inspect "$LATEST" --format '{{ index .Config.Labels "org.agentclaw.openclaw-version" }}' 2>/dev/null || true)"
  [ "$HAVE" != "<no value>" ] || HAVE=""
  if [ -n "$WANT" ] && [ -z "$HAVE" ]; then
    # No version label: an old or hand-built image, OpenClaw unknown. Every
    # image Hatchabot builds or publishes carries one, so it counts as older
    # (HB-0041). Kept, it left new agents building on whatever it holds.
    say "Runtime image here carries no OpenClaw version label; this release's default is $WANT — fetching it…"
    ./scripts/build-runtime-image.sh || echo "⚠ Could not fetch the $WANT image now — run ./scripts/build-runtime-image.sh later, or Settings → Images."
  elif [ -n "$WANT" ] && [ "$HAVE" != "$WANT" ] && [ "$(printf '%s\n%s\n' "$HAVE" "$WANT" | sed 's/-/~/' | sort -V | sed -n 1p)" = "$(printf '%s' "$HAVE" | sed 's/-/~/')" ]; then
    say "Runtime image here carries OpenClaw $HAVE; this release's default is $WANT — fetching it…"
    ./scripts/build-runtime-image.sh || echo "⚠ Could not fetch the $WANT image now — run ./scripts/build-runtime-image.sh later, or Settings → Images."
  else
    say "Runtime image already present — keeping the existing :latest."
  fi
else
  # build-runtime-image.sh pulls this release's published image and builds
  # only when none is published (HB-0021).
  say "Getting the agent runtime image (downloads it, or builds it if none is published)…"
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
  # Written by launchd-plist.sh: the paths XML-escaped, the install dir an argument (#227).
  JOB_PATH="$NODE_DIR:$DOCKER_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
  ./scripts/launchd-plist.sh service "$REPO" "$JOB_PATH" > "$PLIST"
  launchctl unload -w "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
  echo "Manage with: launchctl {load|unload} -w $PLIST"
  echo "Logs: tail -f $REPO/data/server.log"

  # Nightly backups — the launchd counterpart of the systemd timer Linux hosts
  # get; without it a macOS host has no automatic backups at all.
  BACKUP_PLIST="$HOME/Library/LaunchAgents/com.hatchabot.backup.plist"
  ./scripts/launchd-plist.sh backup "$REPO" "$JOB_PATH" > "$BACKUP_PLIST"
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
# The CLI assumes http://localhost:8080. An install on another port (a tenant
# on a shared host, a second install), serving TLS itself (HATCHABOT_TLS_CERT)
# or listening on one address (HATCHABOT_BIND) tells it here, as restart.sh
# and first-run-link.sh reach that listener, so `hbt` works without --url.
# Saved as http://127.0.0.1:<port> whatever those said, the CLI asked plain
# http of an https listener, or loopback of one on a LAN address (HB-1109).
# Read as the service reads them (env_named, above): the last line wins
# (audit, 2026-10-29), and the port as the service takes it (service_port).
P="$(service_port "$ENV_PORT")"
SCHEME=http; [ -z "$ENV_HATCHABOT_TLS_CERT" ] || SCHEME=https
BIND="$ENV_HATCHABOT_BIND"
case "$BIND" in
  # Loopback by address over http, as before; by name over https, which a
  # certificate names more often than an address.
  ""|0.0.0.0|127.0.0.1) CLI_HOST=127.0.0.1; [ "$SCHEME" = http ] || CLI_HOST=localhost ;;
  ::|"[::]"|localhost) CLI_HOST=localhost ;;
  \[*) CLI_HOST="$BIND" ;;
  *:*) CLI_HOST="[$BIND]" ;;   # an IPv6 address goes in brackets in a URL
  *) CLI_HOST="$BIND" ;;
esac
# An address with a zone (a link-local fe80::1%eth0) goes in the URL with its
# % written %25, as RFC 6874 writes it: Node's URL parser takes a zone in
# neither form, so the hatchabot command asks such an address by its host and
# port (zonedTarget, src/config/installTls.ts; HB-1539). Before it could,
# setup saved none for it, and took away one saved (HB-1378).
CLI_ZONED=""
case "$BIND" in
  *%*) CLI_ZONED=1; CLI_HOST="${CLI_HOST/\%/%25}" ;;
esac
CLI_URL="$SCHEME://$CLI_HOST:${P:-8080}"
# One saved already is kept, unless it is this install's listener named as
# it is no more: an address setup writes (loopback or the bind address) on
# this install's port, but another scheme or address. One that an older
# setup saved (http where the install now serves https) stayed, and the
# command could not reach it (HB-1430). Another port is another install's,
# and any other address one set by hand: kept, a zoned one too. The bind
# address with a bare % (as setup wrote it before) is written with %25: a
# bare one before a zone that starts with 25 (fe80::1%251) is read as %25
# and the rest as the zone, so the command asked another one. On this
# install's port, one with a zone in its host while the bind address has
# none is one an older setup wrote from the bind address as it was: put
# right (review of HB-1378). The host alone, in brackets: a % in a path, a
# query or a user name (an escape) is no zone, and a URL set by hand with
# one stays.
zoned_url() {
  local h="${1#*://}"
  h="${h%%[/?#]*}"; h="${h##*@}"
  case "$h" in
    \[*%*\]*) return 0 ;;
  esac
  return 1
}
own_listener() {
  local u="$1" h
  case "$u" in
    http://*|https://*) u="${u#*://}" ;;
    *) return 1 ;;
  esac
  [ "${u##*:}" = "${P:-8080}" ] || return 1
  h="${u%:*}"
  case "$h" in
    127.0.0.1|localhost|"[::1]"|"$CLI_HOST"|"${CLI_HOST/\%25/%}") return 0 ;;
  esac
  [ -z "$CLI_ZONED" ] && zoned_url "$1"
}
# The same address and scheme as setup writes, but its zone's % bare.
spelt_bare() { [ -n "$CLI_ZONED" ] && [ "$1" = "${CLI_URL/\%25/%}" ]; }
SAVED_URL="$( { sed -n 's/^HATCHABOT_URL=//p' ~/.config/hatchabot/env 2>/dev/null || true; } | tail -n1)"
if [ -n "$SAVED_URL" ] && [ "$SAVED_URL" != "$CLI_URL" ] && own_listener "$SAVED_URL"; then
  CLI_SAID="The hatchabot command now goes to $CLI_URL, where this install listens (it had $SAVED_URL)."
  ! spelt_bare "$SAVED_URL" || CLI_SAID="The hatchabot command's saved address now writes its zone's % as %25, as a URL does: $CLI_URL (it had $SAVED_URL; after a bare %, a zone that starts with 25 is misread)."
  CLI_TMP="$(mktemp ~/.config/hatchabot/env.XXXXXX)" \
    && sed "s|^HATCHABOT_URL=.*|HATCHABOT_URL=$CLI_URL|" ~/.config/hatchabot/env > "$CLI_TMP" \
    && mv -f "$CLI_TMP" ~/.config/hatchabot/env \
    && echo "$CLI_SAID" \
    || { rm -f "$CLI_TMP"; echo "⚠ Could not change the hatchabot command's saved address ($SAVED_URL) to $CLI_URL: set HATCHABOT_URL=$CLI_URL in ~/.config/hatchabot/env."; }
fi
case "$CLI_URL" in
  http://127.0.0.1:8080|http://localhost:8080) ;;
  *) grep -q '^HATCHABOT_URL=' ~/.config/hatchabot/env 2>/dev/null || echo "HATCHABOT_URL=$CLI_URL" >> ~/.config/hatchabot/env ;;
esac
if ! grep -q '^HATCHABOT_PASSWORD=' ~/.config/hatchabot/env 2>/dev/null; then
  # A hand-written .env may have no password line (e.g. identity mode) —
  # the CLI prompts in that case, so don't let set -e die on the last step.
  grep '^HATCHABOT_PASSWORD=' .env >> ~/.config/hatchabot/env || true
fi
chmod 600 ~/.config/hatchabot/env

say "Done. Next steps:"
if docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then
  echo "  (Rootless Docker: the first account needs the setup code even here —"
  echo "   find \"first-run setup code\" in: journalctl --user -u hatchabot | tail -50,"
  echo "   or create it from the command line: hatchabot accounts create <you> --host-owner)"
fi
# The port the install actually has (.env, read above), not the first-run
# default: a re-run on a PORT=8101 install said "open :8080" (night review).
# Where to open it — a link and a QR code, with the setup code inside when it is needed.
./scripts/first-run-link.sh "${P:-${HATCHABOT_SETUP_PORT:-8080}}" || true
echo
cat <<EOF | sed "s|__PORT__|${P:-${HATCHABOT_SETUP_PORT:-8080}}|"
  1. Open the link above (or http://localhost:__PORT__ on this machine). With
     family accounts you create your own account there (you become its owner);
     with a shared password you unlock with it.
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
