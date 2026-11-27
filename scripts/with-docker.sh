#!/usr/bin/env bash
# Run a command with access to Docker:
#
#   scripts/with-docker.sh <command> [args…]
#
# Right after the installer adds you to the docker group, nothing already
# running has that group yet — your shell, and the systemd user manager that
# starts Hatchabot — so Docker refused them until you logged out and back in,
# and the installer had to stop and be run a second time (2026-10-06: one run
# now). When Docker is not reachable but /etc/group lists you in `docker`, the
# command is started through `sg docker`, which takes the group from there.
# Once you have logged in again (or after a reboot) it simply runs the command.
set -euo pipefail
[ "$#" -gt 0 ] || { echo "usage: with-docker.sh <command> [args…]" >&2; exit 2; }
if [ "${HATCHABOT_IN_DOCKER_GROUP:-}" = 1 ] || ! command -v sg >/dev/null 2>&1; then exec "$@"; fi
# The probe has a deadline (HB-1060): a daemon that took the request and
# never answered (a stalled remote one, a daemon stuck at boot) held the
# service here, before Node started, with nothing serving to say why. A user
# Docker refuses is told at once (the socket will not let them in), so a probe
# still waiting after 5 s is one Docker let in: the command starts as it is.
# timeout ends it with 124 (137 when it had to kill it). It is coreutils',
# which a Linux may not have (busybox, a minimal image), or have only as
# gtimeout (Homebrew's coreutils); a Mac never gets this far, with no sg
# (above). With neither, the probe ran with no deadline at all (HB-1215): it
# runs in the background, and a watcher ends it after 5 s (TERM, 143), then
# 2 s on (KILL, 137). The watcher has no output of its own: one left sleeping
# holds no pipe open.
RC=0
TIMEOUT="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
if [ -n "$TIMEOUT" ]; then "$TIMEOUT" -k 2 5 docker info >/dev/null 2>&1 || RC=$?
else
  docker info >/dev/null 2>&1 &
  PROBE=$!
  # Ended, it ends every sleep it started and is waited for: killed alone, it
  # left its sleep running, and itself a zombie under the command exec'd
  # below (review of HB-1215). Every job, not the one last named: a sleep
  # forked just before the end came, its pid not yet taken, was left too.
  ( trap 'kill $(jobs -p) 2>/dev/null || true; wait 2>/dev/null || true; exit 0' TERM
    sleep 5 & wait $!; kill -TERM "$PROBE"
    sleep 2 & wait $!; kill -KILL "$PROBE" ) >/dev/null 2>&1 &
  WATCH=$!
  wait "$PROBE" || RC=$?
  kill "$WATCH" 2>/dev/null || true
  wait "$WATCH" 2>/dev/null || true
  [ "$RC" != 143 ] || RC=124
fi
if [ "$RC" = 0 ] || [ "$RC" = 124 ] || [ "$RC" = 137 ]; then exec "$@"; fi
ME="$(id -un)"
# The members read whole, then matched: piped to `grep -q`, which stops at
# its match, tr was left writing a list over a few KB and died of SIGPIPE,
# and under pipefail this user read as no member (HB-1216).
MEMBERS="$(getent group docker 2>/dev/null | cut -d: -f4)" || MEMBERS=""
case ",$MEMBERS," in
  *",$ME,"*) exec sg docker -c "HATCHABOT_IN_DOCKER_GROUP=1 exec $(printf '%q ' "$@")" ;;
esac
exec "$@"
