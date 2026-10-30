#!/usr/bin/env bash
# The installer's last word: where to open Hatchabot, as a link and a QR code
# a phone can scan, instead of hunting for the address (2026-10-06).
#
#   scripts/first-run-link.sh [port]
#
# Waits (up to a minute) for the service to answer. Until the first account
# exists, creating it from another device needs the setup code the server
# printed when it started: it is read from the service's log and carried in the
# link after a "#" — the part a browser never sends to the server — which the
# first-run page fills in and then wipes from the address bar.
set -uo pipefail
cd "$(dirname "$0")/.."
# .env read as the service reads it, and as restart.sh and deploy-release.sh
# do: spaces around the =, quotes and a trailing comment off, the last line
# that sets it. PORT="8123" is a valid setting, and the link said
# localhost:"8123" (audit, 2026-10-22). The Mac's launchd job sources .env
# with bash (launchd-plist.sh), where only NAME=value sets it: PORT = 9137 is
# a command and PORT= 9137 sets nothing, so the service is on 8080 there.
if [ "$(uname -s)" = Darwin ]; then
  envlines() { sed -n -e "/^[[:space:]]*$1=[[:space:]][[:space:]]*[^#[:space:]]/d" -e "s/^[[:space:]]*$1=//p" .env; }
else
  envlines() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env; }
fi
envval() { { envlines "$1" 2>/dev/null || true; } \
  | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e "s/^['\"]//" -e "s/['\"]$//" | tail -n1; }
PORT="${1:-$(envval PORT)}"
PORT="${PORT:-8080}"
# The listener as the service is configured, as restart.sh asks it: https
# when it serves TLS itself (HATCHABOT_TLS_CERT), at its HATCHABOT_BIND
# address when that is one host. Plain http://127.0.0.1 never answered such a
# listener, and the link came without its setup code (audit, 2026-10-29).
SCHEME=http; [ -n "$(envval HATCHABOT_TLS_CERT)" ] && SCHEME=https
BIND="$(envval HATCHABOT_BIND)"
case "$BIND" in
  ""|0.0.0.0) PROBE_HOST=127.0.0.1 ;;
  ::|"[::]"|localhost|127.0.0.1) PROBE_HOST=localhost ;;
  \[*) PROBE_HOST="$BIND" ;;
  *:*) PROBE_HOST="[$BIND]" ;;   # an IPv6 address goes in brackets in a URL
  *) PROBE_HOST="$BIND" ;;
esac
# On this machine: localhost, unless it listens on one other address only.
case "$PROBE_HOST" in 127.0.0.1|localhost) LOCAL="$SCHEME://localhost:$PORT" ;; *) LOCAL="$SCHEME://$PROBE_HOST:$PORT" ;; esac

conf=""
for _ in $(seq 1 60); do
  # -k: this asks whether it is serving; the certificate names the machine's address.
  conf="$(curl -fsSk --max-time 2 "$SCHEME://$PROBE_HOST:$PORT/v1/config" 2>/dev/null)" && break
  sleep 1
done
[ -n "$conf" ] || { echo "  Hatchabot did not answer on port $PORT yet — open $LOCAL in a minute."; exit 0; }

# This machine's address on the home network (the first private IPv4 address).
IP=""
if [ "$(uname -s)" = Darwin ]; then
  for ifc in en0 en1; do IP="$(ipconfig getifaddr "$ifc" 2>/dev/null)" && [ -n "$IP" ] && break; done
else
  IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | sed -n 1p)"
fi
# Only a listener on every address answers there; one bound to a single
# address is reached at that address, and a loopback one only here.
case "$BIND" in ""|0.0.0.0|::|"[::]") ;; *) IP="" ;; esac
URL="${IP:+$SCHEME://$IP:$PORT}"
URL="${URL:-$LOCAL}"

CODE=""
if printf '%s' "$conf" | grep -q '"needsSetup":true'; then
  if [ "$(uname -s)" = Darwin ]; then LOG="$(tail -n 400 data/server.log 2>/dev/null)"
  else LOG="$(journalctl --user -u hatchabot -n 400 --no-pager 2>/dev/null)"; fi
  CODE="$(printf '%s' "$LOG" | grep 'first-run setup code' | sed -nE 's/.*"setupCode":"([0-9a-f]+)".*/\1/p' | tail -1)"
fi
LINK="$URL${CODE:+/#setup=$CODE}"

echo
echo "  Open Hatchabot:  $LINK"
# Docker Desktop and rootless Docker ask for the code at localhost too (agents
# reach this machine's loopback there), so the local link carries it as well.
[ "$URL" = "$LOCAL" ] || echo "  (on this machine: $LOCAL${CODE:+/#setup=$CODE})"
[ -z "$CODE" ] || echo "  Setup code: $CODE — the links and the QR code carry it; you need it only to create the first account."
# The QR code: the qrcode package Hatchabot already has, in the terminal.
NODE="node"; [ -x .node/bin/node ] && NODE=".node/bin/node"
"$NODE" -e 'require("qrcode").toString(process.argv[1], { type: "terminal", small: true }, (e, s) => { if (!e) process.stdout.write("\n" + s + "\n"); })' "$LINK" 2>/dev/null || true
echo "  Scan it with your phone's camera to open Hatchabot there (same Wi-Fi)."
