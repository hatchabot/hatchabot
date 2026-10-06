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
PORT="${1:-$(sed -n 's/^PORT=//p' .env 2>/dev/null | sed -n 1p)}"
PORT="${PORT:-8080}"
LOCAL="http://localhost:$PORT"

conf=""
for _ in $(seq 1 60); do
  conf="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/v1/config" 2>/dev/null)" && break
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
URL="${IP:+http://$IP:$PORT}"
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
[ "$URL" = "$LOCAL" ] || echo "  (on this machine: $LOCAL)"
[ -z "$CODE" ] || echo "  Setup code: $CODE — the link and the QR code carry it; you need it only to create the first account from another device."
# The QR code: the qrcode package Hatchabot already has, in the terminal.
NODE="node"; [ -x .node/bin/node ] && NODE=".node/bin/node"
"$NODE" -e 'require("qrcode").toString(process.argv[1], { type: "terminal", small: true }, (e, s) => { if (!e) process.stdout.write("\n" + s + "\n"); })' "$LINK" 2>/dev/null || true
echo "  Scan it with your phone's camera to open Hatchabot there (same Wi-Fi)."
