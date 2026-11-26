#!/usr/bin/env bash
# Restart the Hatchabot control plane, whichever service manager runs it.
#   ./scripts/restart.sh
set -euo pipefail
[ -x "$(dirname "$0")/../.node/bin/node" ] && PATH="$(cd "$(dirname "$0")/.." && pwd)/.node/bin:$PATH" && export PATH  # a bundle install's own Node (install.sh)
cd "$(dirname "$0")/.."

# npm may live off the non-interactive PATH (macOS launchd/ssh quirk).
command -v npm >/dev/null 2>&1 || PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# HATCHABOT_RESTART_PROBE=1: restarts nothing, and asks once whether the
# service serves the release in this tree (0) or not (1): its page names the
# version in package.json, as the deploy's serving_wait asks. upgrade.sh asks
# it before restarting again a release put back whose restart back did not
# come up: one slow to start that came up since is left serving (kept_check,
# HB-1456).
PROBE_ONLY=0; [ -z "${HATCHABOT_RESTART_PROBE:-}" ] || PROBE_ONLY=1

if [ "$PROBE_ONLY" = 0 ]; then
# Self-heal "pulled but never installed": a dependency added upstream crashes
# the service on import with nothing on screen but a dead port (the Mac peer
# sat broken exactly this way, 2026-09-05).
./scripts/ensure-deps.sh --quiet

if [ "$(uname -s)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.hatchabot.control-plane.plist"
  launchctl unload -w "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
else
  systemctl --user restart hatchabot
fi
fi

# Under an upgrade, its record (HATCHABOT_RESTART_RECORD, named by an
# upgrade.sh from v2.192.0 on) is told that the service manager has restarted
# the service: `started` onto the new release, or `back` onto the release gone
# back to (HATCHABOT_RESTART_BACK=1). A restart.sh that stopped before here
# (ensure-deps) says neither: the release it was to leave never stopped, so
# going back to it is no rollback to write down (left_ran in upgrade.sh, HB-0840).
said_restarted() {
  local rec="${HATCHABOT_RESTART_RECORD:-}" line=started
  [ -n "$rec" ] && [ -f "$rec" ] || return 0
  [ -z "${HATCHABOT_RESTART_BACK:-}" ] || line=back
  printf '%s\n' "$line" >> "$rec" 2>/dev/null || echo "Could not write \"$line\" in $rec (a full disk?), so a rollback from here may not be written down for the next start."
  return 0
}
[ "$PROBE_ONLY" = 1 ] || said_restarted

# A rollback, written down for the next start (HB-0840). What Hatchabot keeps
# for each agent to take up after a restart (agent_holds, from v2.191.0) is
# neither served nor cleared by a release from before it, nor a kind of it by
# a release from before that kind, and the next upgrade took it up days or
# weeks on. So, just before the restart onto the release gone back to, the
# time goes in <database>.rolled-back, beside the database, and the first
# start of a release that knows the table lets go of every hold kept before
# it (src/store/rollbackMark.ts). The database is found as the service finds
# it: HATCHABOT_DB (or AGENTCLAW_DB) in .env, else data/hatchabot.sqlite.
# Never fails the rollback. The same as upgrade.sh's and deploy-release.sh's,
# in scripts/upgrade-helpers.sh (test/nightScripts.test.ts): a copy, as this
# runs under an upgrade whose scripts may be older. mark_rolled_back DIR [RECORD]
# RECORD, the run's record: for a note the run may take away again (an older
# release named, which may never start: unmark_rolled_back). The note already
# there, if any, is kept whole in <note>.prev, to be put back then: written
# over and then removed, a note kept for a later release's holds, or after a
# drop the database refused, was lost (HB-1455). With none there, or no
# RECORD, a .prev an earlier run left goes, never to be put back over this
# note. Then the record says `noted <time>`, so that the repair of a run cut
# off before it could take the note away does it.
mark_rolled_back() {
  local note mark at
  systemd_major "$1/.env"   # here, so that it is asked once a run, not in each reading
  note="$(rolled_back_note "$1")"; mark="${note#*:}"
  [ -n "$mark" ] || return 0
  [ "${note%%:*}" != unread ] || echo "Could not read $1/.env to find the database (no node to read it with, or it failed), so this rollback is written down beside the one the service opens when .env names none, ${mark%.rolled-back}. If .env names another (HATCHABOT_DB), the next start may take up what the release left had still to do for its agents."
  if [ ! -d "$(dirname "$mark")" ]; then
    [ "${note%%:*}" != named ] || echo "The folder of the database .env names (${mark%.rolled-back}) is not there, so this rollback was not written down beside it: the next start may take up what the release left had still to do for its agents."
    return 0
  fi
  # The advice gives the rollback's own time: typed later, the time then let
  # go of what the release gone back to kept since (review of HB-0840).
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # A .prev left there once the release named comes up is harmless: it goes
  # back only over the note written with it (unmark_rolled_back), and goes
  # at the next note. Without RECORD too: a note for a release that ran stands
  # for every hold kept before it, the .prev's too, and a repair put one left
  # back over it (review of HB-1456).
  if [ -n "${2:-}" ] && [ -f "$mark" ]; then cp -p "$mark" "$mark.prev" 2>/dev/null || rm -f "$mark.prev" 2>/dev/null || true
  else rm -f "$mark.prev" 2>/dev/null || true; fi
  [ -z "${2:-}" ] || printf 'noted %s\n' "$at" >> "$2" 2>/dev/null || true
  if ! { printf '%s\n' "$at" > "$mark.tmp" && mv -f "$mark.tmp" "$mark"; } 2>/dev/null; then
    rm -f "$mark.tmp" 2>/dev/null || true
    echo "Could not write $mark (a full disk?), so the next start may take up what the release left had still to do for its agents. Once there is room: printf '%s\n' $at > \"$mark\""
  fi
  return 0
}
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
# in the seven scripts that read .env so (test/backupKeyLine.test.ts).
unset SYSTEMD_MAJOR
systemd_major() {
  [ -z "${SYSTEMD_MAJOR+x}" ] || return 0
  LC_ALL=C grep -q -e '\\$' -e $'\\\\\r' "$1" 2>/dev/null || return 0
  SYSTEMD_MAJOR="$( { systemctl --version 2>/dev/null || true; } | sed -n '1s/^[^0-9]*\([0-9][0-9]*\).*/\1/p')"
}
env_named() {
  # ENV_READ: 1 once .env was read through (no node, or one that failed, reads nothing).
  local kv k
  ENV_READ=''
  systemd_major .env
  for k in "$@"; do printf -v "ENV_$k" '%s' ''; printf -v "ENVSET_$k" '%s' ''; done
  while IFS= read -r -d '' kv; do
    k="${kv%%=*}"
    [ "$k" != . ] || { ENV_READ=1; continue; }
    printf -v "ENV_$k" '%s' "${kv#*=}"; printf -v "ENVSET_$k" '%s' 1
  done < <(
    if [ "$(uname -s)" = Darwin ]; then
      set +eu
      for k in "$@"; do unset "$k"; done
      set -a; . ./.env >/dev/null 2>&1; set +a
      for k in "$@"; do [ -z "${!k+x}" ] || printf '%s=%s\0' "$k" "${!k}"; done
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
    process.stdout.write(".=\0");' "${SYSTEMD_MAJOR:-}" "$@" 2>/dev/null || true
    fi
  )
}
# rolled_back_note DIR: where mark_rolled_back writes, for the service in
# DIR: beside the database it opens, `named:<note>` when .env names it,
# `default:<note>` when it does not, `unread:<note>` (the default's) when a
# .env is there but could not be read (no node, or one that failed: said, not
# passed by), or `none:` when .env names none (an empty
# HATCHABOT_DB: a database the service makes anew at each start). .env is read
# as the service reads it (env_named: systemd's EnvironmentFile rules on
# Linux, where a quoted value or an escaped space is as systemd keeps it and a
# " # ..." after a value is part of it; the launchd job's bash on a Mac):
# HATCHABOT_DB, else AGENTCLAW_DB (the name before the rename), else
# data/hatchabot.sqlite, or data/agentclaw.sqlite when only that is there.
# Read with sed, a comment taken off, `My\ Data` named a folder that is not
# there, and a note written for systemd's value was not where the service
# looked (review of HB-0840).
rolled_back_note() {
  ( cd "$1" 2>/dev/null || exit 0
    env_named HATCHABOT_DB AGENTCLAW_DB
    local db how=named
    if [ -n "$ENVSET_HATCHABOT_DB" ]; then db="$ENV_HATCHABOT_DB"
    elif [ -n "$ENVSET_AGENTCLAW_DB" ]; then db="$ENV_AGENTCLAW_DB"
    else
      how=default; [ -n "$ENV_READ" ] || [ ! -e .env ] || how=unread
      db=data/hatchabot.sqlite
      [ -e "$db" ] || [ ! -e data/agentclaw.sqlite ] || db=data/agentclaw.sqlite
    fi
    [ -n "$db" ] || { printf 'none:\n'; exit 0; }
    case "$db" in /*) ;; *) db="$1/$db" ;; esac
    printf '%s:%s\n' "$how" "$db.rolled-back" )
}

# onto_upgrade_target: whether this tree is the release the upgrade under way
# is going to, by its record, as an upgrade.sh of v2.178.0 to v2.191.0 writes
# it: `to <tag>` in .swapping in a bundle install, against BUNDLE.json's tag
# (its repair puts the previous release's back before it restarts), and in
# the record beside the upgrade's lock in a git one, against the tags on the
# commit checked out. No record, or none that says, is no restart onto it.
# A git install's record from an upgrade.sh of v2.171.0 and older says only
# `from <release>`: the tree is the one it goes to when it is not that release
# (only that upgrade's restart onto the new one runs this restart.sh), and a
# slow first start after upgrading straight from one wrote no note (HB-1455).
onto_upgrade_target() {
  local rec to from dir="${HATCHABOT_UPGRADE_DIR:-$PWD}"
  if [ -f BUNDLE.json ]; then rec=.swapping
  else rec="${XDG_STATE_HOME:-$HOME/.local/state}/hatchabot/upgrade-$(printf %s "$dir" | cksum | cut -d' ' -f1).from"; fi
  [ -f "$rec" ] || return 1
  to="$(sed -n 's/^to //p' "$rec" 2>/dev/null | sed -n 1p)"
  if [ -z "$to" ] && [ ! -f BUNDLE.json ]; then
    from="$(sed -n 's/^from //p' "$rec" 2>/dev/null | sed -n 1p)"
    [ -n "$from" ] && from="$(git rev-parse -q --verify "$from^{commit}" 2>/dev/null)" || return 1
    [ "$(git rev-parse -q --verify HEAD 2>/dev/null)" != "$from" ]; return
  fi
  [ -n "$to" ] || return 1
  if [ -f BUNDLE.json ]; then [ "$(sed -nE 's/.*"tag":"([^"]+)".*/\1/p' BUNDLE.json | sed -n 1p)" = "$to" ]
  else git tag --points-at HEAD 2>/dev/null | grep -qxF -- "$to"; fi
}

# Wait for it to answer, so "restarted" means "actually serving".
# .env (the unit's EnvironmentFile) is what the service runs with; its values
# may be quoted or carry an inline comment — take the bare value, last wins.
# systemd also takes spaces around the = (PORT = 9137): read only as PORT=,
# that was probed on 8080 for a minute and reported down (audit, 2026-10-29).
# The Mac's launchd job sources .env with bash (launchd-plist.sh), where only
# NAME=value sets it: PORT = 9137 is a command, PORT= 9137 sets nothing.
if [ "$(uname -s)" = "Darwin" ]; then
  envlines() { sed -n -e "/^[[:space:]]*$1=[[:space:]][[:space:]]*[^#[:space:]]/d" -e "s/^[[:space:]]*$1=//p" .env; }
else
  envlines() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env; }
fi
envval() { { envlines "$1" 2>/dev/null || true; } \
  | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']$//' \
  | tail -n1; }
PORT="$(envval PORT)"
PORT="${PORT:-8080}"
# The probe asks the listener itself, as the service is configured: https
# when it serves TLS natively (HATCHABOT_TLS_CERT), at its HATCHABOT_BIND
# address when that is one host. Probing plain http://localhost failed a
# healthy native-TLS or LAN-bound listener, and an upgrade rolled back for it.
# -k: this asks whether it is serving, not whether the certificate names
# 127.0.0.1 (it names the machine's real address; doctor checks that one).
SCHEME=http; [ -n "$(envval HATCHABOT_TLS_CERT)" ] && SCHEME=https
BIND="$(envval HATCHABOT_BIND)"
case "$BIND" in
  ""|0.0.0.0|::|"[::]"|localhost|127.0.0.1) PROBE_HOST=localhost ;;
  \[*) PROBE_HOST="$BIND" ;;
  *:*) PROBE_HOST="[$BIND]" ;;   # an IPv6 address goes in brackets in a URL
  *) PROBE_HOST="$BIND" ;;
esac
LISTENER="${SCHEME}://${PROBE_HOST}:${PORT}"
# TLS usually terminates in front (e.g. tailscale serve), so the listener is
# not the front door: report the PUBLIC https URL when configured.
PUBLIC_URL="$( { sed -n 's/^HATCHABOT_PUBLIC_URL=//p' "$HOME/.config/hatchabot/env" 2>/dev/null; sed -n 's/^[[:space:]]*HATCHABOT_PUBLIC_URL[[:space:]]*=[[:space:]]*//p' .env 2>/dev/null; } \
  | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']$//' | tail -n1 || true)"
# 60s, not 30: the DGX control plane takes ~40s to serve, and the old cap
# printed a scary failure for a boot that was going fine.
# Each request has its own deadline, and the wait a total one: a listener that
# took the connection and never answered held one curl, and the upgrade
# waiting on this restart, with no end (HB-0553).
# Asked only whether it serves (PROBE_ONLY): /healthz answered for anything
# listening there, a file server holding a healthz file too, and the release
# put back was left down as serving. A version that cannot be read, in the
# page or in package.json, is not serving it (review of HB-1456).
if [ "$PROBE_ONLY" = 1 ]; then
  WANT="$(node -e 'console.log(require("./package.json").version)' 2>/dev/null || true)"
  GOT="$(curl -sk --connect-timeout 3 --max-time 5 "${LISTENER}/" 2>/dev/null | grep -oE 'HATCHABOT_VERSION="[^"]+"' | sed -n 1p | cut -d'"' -f2 || true)"
  if [ -n "$WANT" ] && [ "$GOT" = "$WANT" ]; then exit 0; fi
  exit 1
fi
DEADLINE=$((SECONDS + 60))
for _ in $(seq 1 60); do
  if curl -sfk --connect-timeout 3 --max-time 5 -o /dev/null "${LISTENER}/healthz"; then
    if [ -n "$PUBLIC_URL" ]; then
      echo "Hatchabot is up — ${PUBLIC_URL}  (listener: ${LISTENER})"
    else
      echo "Hatchabot is up on ${LISTENER}"
      echo "Tip: set HATCHABOT_PUBLIC_URL in ~/.config/hatchabot/env to your https address — invites and Google OAuth redirect URIs use it."
    fi
    exit 0
  fi
  [ "$SECONDS" -lt "$DEADLINE" ] || break
  sleep 1
done
echo "Service was restarted but isn't answering at ${LISTENER}."
# Under an upgrade, which now rolls back: written here too, since the
# upgrade.sh that runs is the release's being left, and one of v2.191.0 and
# older writes none (mark_rolled_back). One that does names its record
# (HATCHABOT_RESTART_RECORD) and writes its own; and a restart back onto the
# release gone back to (HATCHABOT_RESTART_BACK) leaves nothing (HB-0840).
# Only onto the release that upgrade is going to (onto_upgrade_target): an
# older upgrade.sh's repair of a cut-off run restarts the release it goes back
# to with this release's restart.sh too, and a note written while that release
# ran on, slow to answer, let go of its own holds (review of HB-0840).
if [ -n "${HATCHABOT_UPGRADE_COPY:-}" ] && [ -z "${HATCHABOT_RESTART_RECORD:-}" ] && [ -z "${HATCHABOT_RESTART_BACK:-}" ] && onto_upgrade_target; then mark_rolled_back "$PWD"; fi
# Print the reason rather than pointing at it: a crash-on-boot (a bad .env
# line, a duplicate route, a missing dependency) is ALWAYS in these lines, and
# "here are the logs" sends people to restart again instead of reading them.
echo
if [ -s data/server.log ]; then
  echo "Last lines of data/server.log:"
  echo "----------------------------------------------------------------"
  tail -n 20 data/server.log
  echo "----------------------------------------------------------------"
elif command -v journalctl >/dev/null 2>&1; then
  echo "Last lines from the service log:"
  echo "----------------------------------------------------------------"
  journalctl --user -u hatchabot -n 20 --no-pager 2>/dev/null || true
  echo "----------------------------------------------------------------"
fi
echo
echo "If that names a version already fixed upstream, check you are on the"
echo "latest release:  hatchabot doctor   (it reports the tag and any local"
echo "changes that stop the installer upgrading)."
exit 1
