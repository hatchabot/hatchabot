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
# do (env_named): on Linux by systemd's EnvironmentFile rules (spaces around
# the =, quotes off, a " # ..." after a value part of it, the last line that
# sets it), on a Mac as its launchd job sources it with bash
# (launchd-plist.sh), where only NAME=value sets it (PORT = 9137 is a command
# and PORT= 9137 sets nothing, so the service is on 8080 there); a name from
# before the rename too; and the port as the service takes it
# (service_port). PORT="8123" is a valid setting, and the link said
# localhost:"8123" (audit, 2026-10-22); read by sed, a listener set under the
# AGENTCLAW_ names was asked over plain http on 127.0.0.1 (HB-1529).
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
env_named PORT HATCHABOT_TLS_CERT HATCHABOT_BIND
PORT="${1:-$(service_port "$ENV_PORT")}"
# The listener as the service is configured, as restart.sh asks it: https
# when it serves TLS itself (HATCHABOT_TLS_CERT), at its HATCHABOT_BIND
# address when that is one host. Plain http://127.0.0.1 never answered such a
# listener, and the link came without its setup code (audit, 2026-10-29).
SCHEME=http; [ -z "$ENV_HATCHABOT_TLS_CERT" ] || SCHEME=https
BIND="$ENV_HATCHABOT_BIND"
case "$BIND" in
  ""|0.0.0.0) PROBE_HOST=127.0.0.1 ;;
  ::|"[::]"|localhost|127.0.0.1) PROBE_HOST=localhost ;;
  \[*) PROBE_HOST="$BIND" ;;
  *:*) PROBE_HOST="[${BIND//[%]/%25}]" ;;   # an IPv6 address goes in brackets in a URL, a zone's % as %25 (RFC 6874; HB-1378)
  *) PROBE_HOST="$BIND" ;;
esac
# On this machine: localhost, unless it listens on one other address only.
case "$PROBE_HOST" in
  127.0.0.1|localhost) LOCAL="$SCHEME://localhost:$PORT" ;;
  *) LOCAL="$SCHEME://$PROBE_HOST:$PORT" ;;
esac

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
case "$BIND" in
  ""|0.0.0.0|::|"[::]") ;;
  *) IP="" ;;
esac
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
