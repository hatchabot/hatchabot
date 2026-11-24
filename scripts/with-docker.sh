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
# timeout ends it with 124 (137 when it had to kill it).
RC=0
if command -v timeout >/dev/null 2>&1; then timeout -k 2 5 docker info >/dev/null 2>&1 || RC=$?
else docker info >/dev/null 2>&1 || RC=$?; fi
if [ "$RC" = 0 ] || [ "$RC" = 124 ] || [ "$RC" = 137 ]; then exec "$@"; fi
ME="$(id -un)"
if getent group docker 2>/dev/null | cut -d: -f4 | tr ',' '\n' | grep -qx "$ME"; then
  exec sg docker -c "HATCHABOT_IN_DOCKER_GROUP=1 exec $(printf '%q ' "$@")"
fi
exec "$@"
