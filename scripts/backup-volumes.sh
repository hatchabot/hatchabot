#!/usr/bin/env bash
# Nightly agent backups: one tarball per hatchabot volume, 14 days retention
# (an agent's newest copy is kept however old: see the retention at the end).
#
# Backs up the hatchabot volumes found in docker. A volume no agent in the
# registry uses (a leftover from before a rename) is reported, not archived
# every night; when the registry can't be read, every volume is taken — a
# backup tool trusts the disk before it trusts a database it could not read.
# The other way round too: a volume an agent on this machine uses that docker
# does not have is MISSING, and a set without it is incomplete — never
# complete, and never a reason to prune (issue #2, 2026-10-08). Agents on a
# runner are archived over its connection (below), also when this machine has
# no agent volumes of its own (issue #3).
#
# Each set ends with backup-status.json (complete or not, how many volumes,
# which failed, went missing or were left out, and which were captured whole),
# so the app can tell a finished set from a partial one: the dated directory
# exists long before the last volume is in. "captured" is what makes an agent
# recoverable from an incomplete set (docs/recovery-readiness-design.md).
#
#   ./scripts/backup-volumes.sh            # manual run
#   HATCHABOT_BACKUP_DIR=/mnt/nas/claw …   # override destination
#
# Restore (agent must be stopped; --user root because a FRESH volume is
# root-owned and the image's own user can't mkdir in it — the new-machine
# case. Verified by scripts/restore-drill.sh, which caught exactly this):
#   docker run --rm --user root -v <volume>:/data -v <backup-dir>:/in:ro \
#     hatchabot-runtime:latest \
#     bash -c 'cd /data && tar xzf /in/<volume>.tgz --no-same-owner && chown -R 1000:1000 /data'
# The tarballs leave out caches the agent rebuilds on start (TAR_EXCLUDES
# below), so a restored volume without them is complete.
set -euo pipefail
[ -x "$(dirname "$0")/../.node/bin/node" ] && PATH="$(cd "$(dirname "$0")/.." && pwd)/.node/bin:$PATH" && export PATH  # a bundle install's own Node (install.sh)
cd "$(dirname "$0")/.."
# `timeout`, kept in this run's process group. GNU's puts what it runs in a
# group of its own, which the app's time limit (it stops the run's group:
# backupFiles.ts, scriptDeadline) never reached: the step outlived the
# kill, and the run was killed before its EXIT trap could clean up (review
# of HB-0923). --foreground keeps it in ours; a timeout without that option
# (busybox) never leaves the group. On a Mac, Homebrew's coreutils names it
# gtimeout (timeout only with its gnubin on PATH): looked for under that name
# too, or every docker call there had no limit, and the nightly launchd run no
# app limit either (HB-1208). None at all: the app's time limit is the only
# one, and `hatchabot doctor` says so.
TO=""
for t in timeout gtimeout; do
  command -v "$t" >/dev/null 2>&1 || continue
  if "$t" --foreground 5 true >/dev/null 2>&1; then TO="$t --foreground"; else TO="$t"; fi
  break
done

# A run by hand (the README's ./scripts/backup-volumes.sh) gets the settings
# the service and the nightly timer run with: .env, their EnvironmentFile.
# Without it a moved registry (HATCHABOT_DB), another destination or prefix
# was ignored: the stale default database was backed up as complete and the
# real agents' volumes skipped as orphans (audit #023). What the environment
# already has wins — a timed run has .env already, and HATCHABOT_BACKUP_DIR=…
# on the command line still overrides. Read as the service reads it on this
# machine, as uninstall.sh does: by Node's dotenv parser, a key such as
# pass#word (Linux) or "$PART" (a Mac) read as something else than the
# service reads, and that was saved as the set's key, under a mark of it: a
# set that read complete and could not decrypt its credentials (HB-1065).
#  - Linux: systemd's EnvironmentFile rules (the reader is uninstall.sh's,
#    held the same by test/backupKeyLine.test.ts). Nothing runs.
#  - a Mac: the launchd job sources .env (launchd-plist.sh), so it is sourced
#    here too, as that job runs it: by /bin/bash, with launchd's few settings
#    (HOME, PATH, USER, LOGNAME, SHELL, TMPDIR; the PATH this shell's, not the
#    plist's) and nothing on its input. In
#    a subshell of this one, a .env that named a setting from the shell's
#    profile read it, where the job reads it empty, and nothing said so
#    (HB-1233). That runs nothing the service does not run at every start.
# Each reading also says, as a record starting with a dot, the key .env itself
# gives, whatever the environment has: compared with this run's below.
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
FILE_HB_SET=""; FILE_HB=""; FILE_AC=""
file_key() {
  case "${1%%=*}" in
    .HATCHABOT_SECRET_KEY) FILE_HB_SET=1; FILE_HB="${1#*=}" ;;
    .AGENTCLAW_SECRET_KEY) FILE_AC="${1#*=}" ;;
  esac
}
if [ -f .env ]; then
  if [ "$(uname -s)" = Darwin ]; then
    NODE_BIN="$(command -v node || true)"
    LAUNCHD_ENV=(HOME="$HOME" PATH="$PATH")
    for v in USER LOGNAME SHELL TMPDIR; do [ -z "${!v:-}" ] || LAUNCHD_ENV+=("$v=${!v}"); done
    while IFS= read -r -d '' kv; do
      case "$kv" in .*) file_key "$kv" ;; *) k="${kv%%=*}"; [ -n "${!k+x}" ] || export "$kv" ;; esac
    done < <(
      env -i "${LAUNCHD_ENV[@]}" /bin/bash -c 'set -a; . ./.env >/dev/null 2>&1; set +a; exec "$@"' launchd-job \
        "$NODE_BIN" -e 'for (const [k, v] of Object.entries(process.env)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) process.stdout.write((/^(HATCHABOT|AGENTCLAW)_SECRET_KEY$/.test(k) ? "." + k + "=" + v + "\0" : "") + k + "=" + v + "\0");' </dev/null)
  else
    systemd_major .env
    while IFS= read -r -d '' kv; do case "$kv" in .*) file_key "$kv" ;; *) export "$kv" ;; esac; done < <(node -e '
    // EnvironmentFile, state by state as systemd reads it (parse_env_file).
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
    for (const [k, v] of Object.entries(systemd(require("node:fs").readFileSync(".env", "utf8"), process.argv[1]))) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      if (/^(HATCHABOT|AGENTCLAW)_SECRET_KEY$/.test(k)) process.stdout.write("." + k + "=" + v + "\0");
      if (process.env[k] === undefined) process.stdout.write(k + "=" + v + "\0");
    }' "${SYSTEMD_MAJOR:-}")
  fi
fi

# The server namespaces its volumes under HATCHABOT_PREFIX — back up whatever
# namespace this installation actually uses, not a hardcoded one.
# Pre-rename .env files: alias AGENTCLAW_* → HATCHABOT_* (existing HATCHABOT_* wins).
for v in $(compgen -A variable AGENTCLAW_ 2>/dev/null); do n="HATCHABOT_${v#AGENTCLAW_}"; [ -n "${!n+x}" ] || export "$n=${!v}"; done
# The set's key is the one the service encrypts with: .env's. One exported in
# the shell that ran this by hand won over it, as any setting there does, and
# was saved instead: the set read complete and could not decrypt its
# credentials (HB-1065 review). So a run by hand with a key that is not .env's
# is refused. The timer runs with .env's own key. The app's own run ("Back up
# now", HATCHABOT_BACKUP_BY_APP=1, backupFiles.ts) has the key the service
# started with, which encrypted the stored credentials: when .env's was changed
# since, that is still the one to save, so the run goes on, and says so at its
# start and again at its end (KEY_WARN, finish), where the app shows it.
KEY_WARN=""
if [ -n "$FILE_HB_SET" ]; then FILE_KEY="$FILE_HB"; else FILE_KEY="$FILE_AC"; fi
RUN_KEY="${HATCHABOT_SECRET_KEY-${AGENTCLAW_SECRET_KEY-}}"
if [ -n "$FILE_KEY" ] && [ -n "$RUN_KEY" ] && [ "$FILE_KEY" != "$RUN_KEY" ]; then
  if [ "${HATCHABOT_BACKUP_BY_APP:-}" = 1 ]; then
    KEY_WARN="  ⚠ The HATCHABOT_SECRET_KEY in $PWD/.env is not the one the service runs with. This set saves the service's, which reads the stored credentials; at its next restart the service reads .env's and will not. Put back in .env the key it had."
    echo "$KEY_WARN" >&2
  else
    echo "✗ This run's HATCHABOT_SECRET_KEY, from the shell that started it, is not the one in $PWD/.env, which the service reads — nothing was written: a set saved with this one could not decrypt its credentials." >&2
    echo "  Unset it in this shell (unset HATCHABOT_SECRET_KEY AGENTCLAW_SECRET_KEY), then run this again." >&2
    exit 1
  fi
fi
unset FILE_KEY RUN_KEY FILE_HB FILE_AC
PREFIX="${HATCHABOT_PREFIX:-hatchabot}"
BASE="${HATCHABOT_BACKUP_DIR:-$HOME/hatchabot-backups}"
[ -d "$BASE" ] || [ -n "${HATCHABOT_BACKUP_DIR:-}" ] || { [ -d "$HOME/agentclaw-backups" ] && BASE="$HOME/agentclaw-backups"; }   # pre-rename hosts
DEST="$BASE/$(date +%F)"
IMAGE="${HATCHABOT_IMAGE:-hatchabot-runtime:latest}"
# A whole number of days above 0 (six digits at most), as the app reads it (src/orchestrator/backups/backupFiles.ts,
# keepDays): anything else is the default, and said. "14d" stopped the run at the
# retention's find, with every volume taken, so every set read incomplete and
# nothing was ever pruned; 0 removed all but each agent's newest copy under a
# panel that said 14 (HB-0432).
KEEP_DAYS="$(printf '%s' "${HATCHABOT_BACKUP_KEEP_DAYS:-14}" | tr -d '[:space:]')"
case "$KEEP_DAYS" in
  *[!0-9]*) KEEP_DAYS="" ;;
  *) KEEP_DAYS="$(printf '%s' "$KEEP_DAYS" | sed 's/^0*//')"; [ "${#KEEP_DAYS}" -le 6 ] || KEEP_DAYS="" ;;
esac
if [ -z "$KEEP_DAYS" ]; then
  echo "  ⚠ HATCHABOT_BACKUP_KEEP_DAYS=${HATCHABOT_BACKUP_KEEP_DAYS:-} is not a whole number of days above 0: keeping 14 days." >&2
  KEEP_DAYS=14
fi

# Whose a set is (below): key_owner and set_owner, from scripts/backup-owner.sh
# (the one copy). Read before this run makes the day's folder, and refused
# when it cannot be read: sourced unguarded under set -e further down, after
# the mkdir, a missing helper left an empty dated folder with no record, which
# the app lists as a complete set from today (fifteenth review). Not stand-ins
# that say no owner, as restore-drill.sh has (it only reads): this run writes
# into a set that may be another install's, and could not tell.
if ! { [ -r scripts/backup-owner.sh ] && . scripts/backup-owner.sh && declare -F key_owner set_owner >/dev/null; }; then
  echo "✗ Could not read $PWD/scripts/backup-owner.sh: without it this run cannot tell whose the sets in $BASE are, so it stops before writing anything. Put the install's files back (a reinstall or an upgrade does)." >&2
  exit 1
fi

# Tarballs contain openclaw.json — bot tokens and gateway tokens in the clear.
# A base this run makes is 0700; one that is already there is left as it is
# (chmod'ing a NAS share others use locked them out, 2026-10-09). Each dated
# set is 0700 whatever the base, and that is what guards the files.
[ -d "$BASE" ] || mkdir -m 700 -p "$BASE"
mkdir -m 700 -p "$DEST"
# mkdir -m only applies on creation — tighten a pre-existing directory too.
chmod 700 "$DEST"
umask 077

# One run per set at a time: the nightly timer and "Back up now" (or two
# installs sharing a base) both wrote '<volume>.tgz' and the record into the
# same set at once (2026-10-09). mkdir is atomic everywhere (macOS has no
# flock); the lock holds this run's pid, so one a SIGKILL left behind is
# taken over. A run that finds the set locked stops before it writes anything.
LOCK="$DEST/.backup-lock"
holder=""
# Whether pid $1 is running. Another user's run (two installs sharing a base)
# answers kill -0 with "not permitted", and was taken for dead: its lock was
# taken over mid-run (HB-0071). Only "no such process" is gone, as the app's
# own check has it (src/orchestrator/backups/backupFiles.ts, lockHeld).
pid_alive() {
  local e
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  e="$(LC_ALL=C kill -0 "$1" 2>&1)" && return 0
  case "$e" in *"No such process"*) return 1 ;; esac
  return 0
}
lock_busy() {
  holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  # No pid yet: a run that has just made the lock — unless the lock is old.
  { [ -n "$holder" ] && pid_alive "$holder"; } || { [ -z "$holder" ] && [ -d "$LOCK" ] && [ -z "$(find "$LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ]; }
}
locked_out() {
  echo "✗ Another backup run${holder:+ (pid $holder)} is writing $DEST — this one stops; that run's record will say how it went." >&2
  exit 1
}
if ! mkdir "$LOCK" 2>/dev/null; then
  lock_busy && locked_out
  # Taking over a dead run's lock is one run at a time, and is decided again
  # inside: two runs that both read the same dead pid each wrote their own
  # and both went on, into the same set (#215). A takeover a SIGKILL cut
  # short is cleared when old; the run that clears it stops, the next goes on.
  if ! mkdir "$LOCK.takeover" 2>/dev/null; then
    find "$LOCK.takeover" -maxdepth 0 -mmin +1 -exec rmdir {} \; 2>/dev/null || true
    holder=""; locked_out
  fi
  if lock_busy; then rmdir "$LOCK.takeover"; locked_out; fi
  rm -rf "$LOCK"
  # A run that came in by the front door meanwhile has it now.
  if ! mkdir "$LOCK" 2>/dev/null; then rmdir "$LOCK.takeover"; holder=""; locked_out; fi
  echo "$$" > "$LOCK/pid"
  rmdir "$LOCK.takeover"
  echo "  • an earlier run that was killed left its lock on $DEST — taken over" >&2
fi
echo "$$" > "$LOCK/pid"
# Only this run's own lock: one that names another run is that run's (#215).
release_lock() { [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"; return 0; }
trap release_lock EXIT
# Stopped by a signal (the service restarting, a shutdown), bash ran the EXIT
# trap with the last command's 0, and finish wrote "complete" for a set cut
# short (HB-0368). Ended through exit, it is recorded incomplete.
trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP

# The set's own record. "running" until the end; whatever way the script ends
# (a refusal, a failed volume, set -e, Ctrl-C) the EXIT trap writes the verdict.
# Only a SIGKILL leaves "running", which the app reads as unfinished once it
# is hours old (review, 2026-09-29).
STATUS="$DEST/backup-status.json"
count=0
failed=0
# Of those, left out because a change was replacing their files (replacing, below).
# Named in "replacing" too, and kept in failedVolumes, so a reader from before
# the list reads the set as before (HB-1205).
replacing_n=0
replacing_list=""
failed_list=""
missing_list=""
captured_list=""
orphan_list=""
skipped_list=""
# The sets the retention kept only for volumes no agent here has had
# (HB-1380), as JSON members: "<set>":[<volumes>]. hatchabot doctor lists
# them, with their size and how to remove one (review of HB-1380). Written
# only by a run whose retention ran: a run that pruned nothing knows none,
# and doctor then reads an earlier run's.
kept_unlisted=""
retention_ran=""
started="$(date -u +%FT%TZ)"
json_list() { local out="" x; for x in $1; do out="$out${out:+,}\"$x\""; done; printf '[%s]' "$out"; }
write_status() {
  local kept=""
  [ -z "$retention_ran" ] || kept=",\"keptUnlisted\":{$kept_unlisted}"
  printf '{"state":"%s","startedAt":"%s","finishedAt":"%s","volumes":%d,"failed":%d,"failedVolumes":%s,"replacing":%s,"missing":%s,"orphans":%s,"skipped":%s,"captured":%s%s}\n' \
    "$1" "$started" "$(date -u +%FT%TZ)" "$count" "$failed" "$(json_list "$failed_list")" "$(json_list "$replacing_list")" "$(json_list "$missing_list")" "$(json_list "$orphan_list")" "$(json_list "$skipped_list")" "$(json_list "$captured_list")" "$kept" \
    > "$STATUS.tmp" && mv -f "$STATUS.tmp" "$STATUS"
}
# The record starts only once the run can really begin (below): a run that
# refuses before it starts (no database, no docker) must not replace the
# verdict of an earlier run of the same day with "incomplete, 0 volumes".
# A run that does start carries over what an earlier run of the same day wrote
# whole: an archive is renamed from .part only once it is whole, so the
# morning's stay good through a noon run cut short, and this run's record alone
# hid them from a restore (HB-0433). A record from before "captured" has no list:
# its archives are all whole, by that same rename. Printed one name a line.
earlier_captured() {
  [ -f "$STATUS" ] || return 0
  node -e '
    const fs = require("node:fs"), path = require("node:path");
    const dir = process.argv[2];
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const names = Array.isArray(r.captured) ? r.captured
      : fs.readdirSync(dir).filter((f) => f.endsWith(".tgz")).map((f) => f.slice(0, -4));
    for (const v of names) if (typeof v === "string" && /^[\w.-]+$/.test(v) && fs.existsSync(path.join(dir, v + ".tgz"))) console.log(v);' \
    "$STATUS" "$DEST" 2>/dev/null || true
}
# Whole this run (and so not asked about again), beside what was already whole.
this_run=""
add_captured() {
  this_run="$this_run $1"
  case " $captured_list " in *" $1 "*) ;; *) captured_list="$captured_list $1" ;; esac
}
# An archive container, while one is running ("<host>|<name>", no host for
# this machine). Named so it can be removed: a timeout kills only the docker
# client, and the container went on reading the agent's volume after the
# backup had failed (#216), on a runner and here alike (HB-0348). Removed
# (and waited for) on a failure, and on any way out of the run.
oneshot=""
# A tcp:// runner is spoken to over verified TLS only, as the app does
# (src/providers/runnerEndpoint.ts, dockerConnArgs): without it a runner set up
# with TLS did not answer and was skipped as asleep, and a plain one was read
# with nobody asked who it was (HB-0277). Printed for an unquoted $(…).
tls_args() { case "$1" in [Tt][Cc][Pp]://*) printf '%s' --tlsverify ;; esac; }
reap_oneshot() {
  [ -n "$oneshot" ] || return 0
  local t="$TO" h="${oneshot%%|*}"
  # shellcheck disable=SC2046  # no flag, or one
  ${t:+$t 120} docker ${h:+-H "$h"} $(tls_args "$h") rm -f "${oneshot#*|}" </dev/null >/dev/null 2>&1 || true
  oneshot=""
}
finish() { local rc=$?; reap_oneshot; if [ "$rc" -eq 0 ]; then write_status complete; else write_status incomplete; fi; release_lock; [ -z "$KEY_WARN" ] || echo "$KEY_WARN" >&2; exit "$rc"; }

# The control plane's own database first: it holds the encrypted bot tokens,
# the agent registry, memberships and snapshots. Volumes survive without it,
# but Hatchabot would forget every agent it ever made. Use SQLite's online
# backup API — the DB is in WAL mode, so `cp` on a running server can tear.
DB_PATH="${HATCHABOT_DB:-data/hatchabot.sqlite}"
[ -f "$DB_PATH" ] || [ -n "${HATCHABOT_DB:-}" ] || { [ -f data/agentclaw.sqlite ] && DB_PATH=data/agentclaw.sqlite; }   # pre-rename default
if [ ! -f "$DB_PATH" ]; then
  echo "✗ No database at $DB_PATH — a backup without the registry is not a backup." >&2
  exit 1
fi
# Whose set this is. Two installs sharing a base (another prefix, or another
# machine on a NAS) wrote the same day's set in turn, and the later one's
# registry and key replaced the earlier one's beside its archives: that set
# no longer restored the first install (HB-0280). A set names its install by
# a fingerprint of the key (each install has its own, for good; never the key
# itself), and a set of another install's is left as it is: this run stops
# before it writes anything, and retention below passes over such sets. A run
# with no key has no fingerprint: it leaves an already identified set alone;
# for a new set the key step below fails it, and that set says incomplete.
# key_owner and set_owner
# (scripts/backup-owner.sh, read above) make and read the fingerprint: of the
# key in the environment, which has .env's (above), as the app reads it.
owner="$(key_owner)"
OWNER_FILE=".backup-owner"
# The same rule as retention and restore: an older set has no owner file,
# but its saved key still identifies it. Otherwise a second install could
# replace today's legacy registry and key while keeping the first's archives.
dest_owner="$(set_owner "$DEST")"
if [ -z "$owner" ] && [ -n "$dest_owner" ]; then
  echo "✗ No usable HATCHABOT_SECRET_KEY — this run cannot identify this install, so it leaves the existing backup set $DEST unchanged. Restore the install's key before trying again." >&2
  exit 1
fi
if [ -n "$owner" ] && [ -n "$dest_owner" ] && [ "$dest_owner" != "$owner" ]; then
  echo "✗ $DEST is another Hatchabot install's backup set (two installs share $BASE) — this run stops and leaves it as it is. Give each install a HATCHABOT_BACKUP_DIR of its own." >&2
  exit 1
fi
[ -z "$owner" ] || printf '%s\n' "$owner" > "$DEST/$OWNER_FILE"
# Past the refusal: from here on this run writes into the set, so it owns
# the day's record (a later failure is recorded as incomplete, rightly).
while IFS= read -r v; do [ -z "$v" ] || captured_list="$captured_list $v"; done < <(earlier_captured)
write_status running
trap finish EXIT
node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.argv[1], { readonly: true });
  db.backup(process.argv[2]).then(() => { db.close(); })
    .catch((e) => { console.error(e); process.exit(1); });
' "$DB_PATH" "$DEST/hatchabot.sqlite"
chmod 600 "$DEST/hatchabot.sqlite"
echo "  ✓ control plane database → $DEST/hatchabot.sqlite"
# Without the key the backup's secrets are undecryptable, so keep a copy
# beside it. Both are only as safe as this directory (0700).
# The effective environment only, which holds .env as the service reads it
# (above): .env read again by Node's parser here gave a key the service
# never had (HB-1065). Never print the key. A missing key makes the set
# incomplete and stops before retention can remove any older set.
# Keep any key already captured in this dated set if validation fails.
if ! node - "$DEST/secret-key.env" <<'KEY'
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const key = process.env.HATCHABOT_SECRET_KEY ?? process.env.AGENTCLAW_SECRET_KEY;
if (!key || /[\r\n]/.test(key)) process.exit(1);
// The line is copied into a recovered .env (README), which Node (parseEnv),
// systemd's EnvironmentFile and the macOS launcher's shell all read: quotes
// none of them escapes inside, so each reads the exact bytes. Double quotes
// for a key without " \ $ or a backtick (every key so far), else single
// quotes for one without '. Written bare in double quotes, a key holding a "
// came back cut short, and the backed-up credentials with it (audit #022).
// A key that fits neither, or does not read back whole, is no usable copy.
const q = !/["\\$`]/.test(key) ? '"' : !key.includes("'") ? "'" : undefined;
const line = q && `HATCHABOT_SECRET_KEY=${q}${key}${q}\n`;
if (!line || parseEnv(line).HATCHABOT_SECRET_KEY !== key) {
  console.error("✗ HATCHABOT_SECRET_KEY has a ' and one of \" \\ $ ` in it: no .env line reads back as that key everywhere, so no copy of it was saved. Keep your own copy of .env.");
  process.exit(1);
}
fs.writeFileSync(process.argv[2], line, { mode: 0o600 });
KEY
then
  echo "✗ No usable HATCHABOT_SECRET_KEY — backup incomplete; older backups were kept." >&2
  failed=$((failed + 1))
  exit 1
fi
# The key saved is tried on the set's own secrets, as restore-drill.sh does
# (HB-1228): a key that reads none of them back saved a set whose bot tokens
# and keys nobody can read, and the service, on that same key, cannot read
# them either. Any row it decrypts will do (a secret left from an older key
# beside today's is not this); no secrets at all is fine. As
# LocalSecretStore reads them (src/secrets/localSecretStore.ts): the key as
# keyFromEnv makes it, AES-256-GCM with a 12-byte iv and a 16-byte tag. The
# volumes are still taken; the set says incomplete at the end, so nothing is
# pruned. Exit 3: rows, none read; any other failure is a check not made.
KEY_UNREAD=""
key_rc=0
key_rows="$(node - "$DEST/hatchabot.sqlite" "$DEST/secret-key.env" <<'TRY'
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const { createDecipheriv, scryptSync } = require('node:crypto');
const Database = require('better-sqlite3');
const saved = parseEnv(fs.readFileSync(process.argv[3], 'utf8')).HATCHABOT_SECRET_KEY ?? '';
const key = /^[0-9a-fA-F]{64}$/.test(saved) ? Buffer.from(saved, 'hex') : scryptSync(saved, 'agentclaw-secret-store-v1', 32);
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
let rows = 0, read = false;
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'secrets'").get()) {
  for (const r of db.prepare('SELECT iv, tag, ciphertext FROM secrets').iterate()) {
    rows++;
    try {
      const d = createDecipheriv('aes-256-gcm', key, r.iv, { authTagLength: 16 });
      d.setAuthTag(r.tag);
      Buffer.concat([d.update(r.ciphertext), d.final()]);
      read = true;
      break;
    } catch { /* stored with another key, or torn: the next one */ }
  }
}
db.close();
if (rows > 0 && !read) { console.log(rows); process.exit(3); }
if (rows === 0) console.log('none');
TRY
)" || key_rc=$?
if [ "$key_rc" -eq 3 ]; then
  KEY_UNREAD=1
  echo "✗ The saved HATCHABOT_SECRET_KEY decrypts none of the $key_rows secrets in the backed-up database: it is not the key they were stored with, so neither this set nor the running service can read them (bot tokens, AI keys). The volumes are still taken; the set will say incomplete, and older backups are kept. Put back the key they were stored with (an older set's secret-key.env may have it), or give the app its tokens and keys again, then back up again." >&2
elif [ "$key_rc" -ne 0 ]; then
  echo "  ⚠ The saved key could not be tried on the backed-up secrets (exit $key_rc): this set's key copy is not checked." >&2
elif [ "$key_rows" = none ]; then
  echo "  ✓ the backed-up database holds no secrets: the saved key had none to be tried on"
else
  echo "  ✓ saved key reads the backed-up secrets"
fi

# This machine's docker calls are bounded, as a runner's are below: a daemon
# that took the call and never answered held the run (and "Back up now", and
# every restore it refuses) for good (HB-0923). -k: a client that ignores the
# TERM is killed. Without a timeout command (macOS without coreutils) the app
# stops the whole run at its own limit (backupFiles.ts, scriptDeadline).
TL="${TO:+$TO -k 10}"
# The run's own time limit, the app's for "Back up now" (backupFiles.ts,
# BACKUP_KILL_MS), held the same by test/backupCompleteness.test.ts.
RUN_LIMIT_SEC=21600
# The runtime image normally provides tar; on a host that hasn't built it yet
# any stock image will do — tar is all we need here.
if ! ${TL:+$TL 60} docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "  ⚠ $IMAGE not found — falling back to debian:stable-slim for tar." >&2
  IMAGE="debian:stable-slim"
fi

# Under a rootless daemon, root in the container IS this user, and this user's
# uid in there is one of the sub-uids. An archive chowned to it came out owned
# by that sub-uid, mode 0600: this user could rename it but not read or chmod
# it, and no restore or drill could use it (HB-0406). There, as root it already
# is this user's: no chown.
ROOTLESS=0
case "$(${TL:+$TL 60} docker info --format '{{.SecurityOptions}}' 2>/dev/null || true)" in *name=rootless*) ROOTLESS=1 ;; esac

# List the volumes FIRST, and distinguish "daemon down" from "no volumes".
# `docker volume ls` failing (daemon down/permission) must not masquerade as
# an empty list — that produced a 0-volume "success" that then pruned the last
# good backups. Only a clean exit with genuinely no matches is "nothing here".
if ! all_vols="$(${TL:+$TL 120} docker volume ls -q)"; then
  echo "✗ Could not list docker volumes (daemon down or no permission) — backup aborted, nothing pruned." >&2
  exit 1
fi
vols="$(printf '%s\n' "$all_vols" | grep -E "^(${PREFIX}|agentclaw)-" || true)"
# An agent's kept browser logins (Keep its logins, docs/browser.md): never in a
# set. A backup is files anyone with the disk can read, often on a NAS, and the
# cookies in one are as good as passwords; a restore would bring back sign-ins
# forgotten on purpose. Left out by their label, and not called orphans either.
# The registry above names them nowhere, so a set never waits for one. Only a
# volume whose label AND name say so: an agent's own volume is never left out.
logins_vols="$(${TL:+$TL 120} docker volume ls -q --filter label=hatchabot.role=browser-logins 2>/dev/null | grep -E -- '-browser-logins-[0-9a-f]{12}$' || true)"
if [ -n "$logins_vols" ] && [ -n "$vols" ]; then
  vols="$(printf '%s\n' "$vols" | grep -vxF -f <(printf '%s\n' "$logins_vols") || true)"
fi

# What the registry (the DB copy just made) says should be backed up, one
# line per agent that has a runtime (its volume by the provider's own rule,
# src/providers/dockerNames.ts — `<runtime ref name>-vol`, or for a legacy
# pre-slug ref `agentclaw-vol-<short>`; a rule of its own took that volume for
# an orphan and missed it every night, audit #021):
#   known  <vol>          every such agent — a volume no agent uses is an orphan
#   local  <vol>          an agent on THIS machine: its volume must be in the set
#   failed <vol>          one on this machine that never came up (FAILED): its
#                         volume is taken when there, but a first start that
#                         failed purged it, and that must not hold every set
#                         incomplete (and unpruned) until someone deletes it
#   remote <vol> <host> <state>
#                         an agent on a runner, read over `docker -H <host>`
#   id     <vol> <agent>  whose volume it is (replacing, below)
#   deleted <vol>         an agent that was deleted (the retention below)
# and a last line "ok". No "ok": the DB copy could not be read — then every
# volume is taken, as before, and none is expected. An install from before
# runners (no hosts table) has local agents only.
registry="$(node -e '
  const D = require("better-sqlite3"); const db = new D(process.argv[1], { readonly: true });
  // dockerNames (src/providers/dockerNames.ts), kept the same by test/dockerNames.test.ts.
  const P = process.argv[2];
  const vol = (ref) => {
    const s = String(ref);
    if (!s.startsWith("docker://")) return s.replace(/^\w+:\/\//, "") + "-vol";
    const n = s.slice("docker://".length);
    if (n.startsWith(P + "-") || n.startsWith("agentclaw-")) return n + "-vol";
    return (P === "hatchabot" ? "agentclaw" : P) + "-vol-" + n.slice(0, 12);
  };
  const runners = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", "hosts")
    && db.prepare("PRAGMA table_info(agents)").all().some((c) => c.name === "host_id");
  const q = runners
    ? "SELECT a.id id, a.runtime_ref ref, a.state st, h.kind kind, h.settings s FROM agents a LEFT JOIN hosts h ON h.id = a.host_id" +
      " WHERE a.state != ? AND a.runtime_ref IS NOT NULL"
    : "SELECT id, runtime_ref ref, state st, NULL kind, NULL s FROM agents WHERE state != ? AND runtime_ref IS NOT NULL";
  for (const r of db.prepare(q).all("DELETED")) {
    const v = vol(r.ref);
    console.log("known\t" + v);
    console.log("id\t" + v + "\t" + r.id);
    // No host row (or kind local): this machine — the safe side, since an
    // expected volume can only hold a set back from pruning.
    if (r.kind == null || r.kind === "local") { console.log((r.st === "FAILED" ? "failed" : "local") + "\t" + v); continue; }
    let host; try { host = JSON.parse(r.s || "{}").dockerHost; } catch {}
    if (host) console.log("remote\t" + v + "\t" + host + "\t" + r.st);
  }
  for (const r of db.prepare("SELECT runtime_ref ref FROM agents WHERE state = ? AND runtime_ref IS NOT NULL").all("DELETED"))
    console.log("deleted\t" + vol(r.ref));
  console.log("ok");' "$DEST/hatchabot.sqlite" "$PREFIX" 2>/dev/null || true)"
registry_read=""
known=""
deleted_vols=""
expected=""
expected_failed=""
remote=""
agent_ids=""
while IFS=$'\t' read -r what rvol rhost rstate; do
  case "$what" in
    known) known="$known$rvol"$'\n' ;;
    deleted) deleted_vols="$deleted_vols$rvol"$'\n' ;;
    id) agent_ids="$agent_ids$rvol"$'\t'"$rhost"$'\n' ;;
    local) expected="$expected $rvol" ;;
    failed) expected_failed="$expected_failed $rvol" ;;
    remote) remote="$remote$rhost"$'\t'"$rvol"$'\t'"$rstate"$'\n' ;;
    ok) registry_read=1 ;;
  esac
done <<<"$registry"

if [ -z "$vols" ]; then
  # No matching volumes. Only the agents on THIS machine are expected in
  # `docker volume ls` here — a fleet that lives on runners has none, and its
  # volumes are taken below (issue #3). Agents here without their volumes
  # (removed, or a different HATCHABOT_PREFIX) are named as missing below,
  # and the set is incomplete: nothing is pruned.
  if [ -z "$registry_read" ]; then
    echo "✗ No ${PREFIX}-* volumes found and the database copy could not be read — refusing to prune." >&2
    exit 1
  fi
  # No agents at all (none yet, or the last one deleted): the set is the
  # database alone, and complete (NOTHING_TO_TAKE, below). It goes on to the
  # retention: it ended here, and with its last agent gone an install kept
  # every older set, the deleted agents' data in them, for good (HB-1110).
  if [ -z "$expected$expected_failed$remote" ]; then
    echo "No agents yet — database backed up, no volumes to capture."
  fi
fi

# A change that replaces an agent's files, under way on it now in the live
# registry (or, given a time in ms, begun since then): what it is, printed.
# A restore that had begun went on under this run's archive of the volume,
# and the half-restored copy was kept as the agent's (HB-0922). A restore
# that begins once this run holds its lock is refused (backupFiles.ts,
# backupRunning); a restore from a snapshot, an import or a move is not, so
# each archive is asked about again before it is kept. The kinds are the
# app's FILES_REPLACED_BY (src/orchestrator/lifecycle/operations.ts), held
# the same by test/backupCompleteness.test.ts. A registry that cannot be read
# prints nothing: the volume is taken, as above.
#
# Running or interrupted (cut off by a restart, settled at the next start),
# any of those kinds. Held for the owner's choice, only the kinds whose hold
# leaves its files half-replaced: a restore from a backup or a snapshot
# (half-written, "finish it or put back the copy from before"), an import
# (a half-made copy waiting to be removed) and a workspace adopt (its copy
# torn part way, "adopt again", HB-0980). The others' holds leave the
# files whole, and the agent was left out of every backup until its owner
# chose: an app update or roll back (the agent runs on and changes), a move
# (held after its copy, or with the copy left behind), a move to another
# Hatchabot (its copy here stays stopped), an archive, a rebuild or a setup
# (held only when putting it right after a restart failed) (review of HB-0922).
#
# Since a time: one asked for since then, or one whose row changed since then.
# A rebuild queued before the archive began, then started and finished under
# it, was asked for before it and kept (review of HB-0922). A hold of a kind
# that leaves the files whole is no bar before the archive; after it, one that
# ran under it is, held now or not: a rebuild that began during the copy and
# was left held by an app restart mid-copy was passed over as held, and its
# copy kept (HB-1206). Only a held move to another Hatchabot is no bar by its
# row: the question asked again every ten minutes writes it each time.
replacing() {
  local id
  id="$(awk -F'\t' -v v="$1" '$1 == v { print $2; exit }' <<<"$agent_ids")"
  [ -n "$id" ] || return 0
  node -e '
    const D = require("better-sqlite3"); const db = new D(process.argv[1], { readonly: true, fileMustExist: true });
    const said = { "move-host": "a move to another machine", migrate: "a move to another Hatchabot", import: "an import",
      "restore-backup": "a restore from a backup", "restore-snapshot": "a restore from a snapshot", provision: "its setup",
      rebuild: "a rebuild", archive: "an Archive", "app-update": "an app update", "app-rollback": "an app roll back",
      "adopt-workspace": "adopting a workspace" };
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", "operations")) process.exit(0);
    const kinds = Object.keys(said), since = Number(process.argv[3] || 0);
    const heldHalf = ["restore-backup", "restore-snapshot", "import", "adopt-workspace"];
    const after = (t) => since > 0 && Date.parse(t) >= since;
    const op = db.prepare("SELECT kind, status, requested_at began, updated_at changed FROM operations WHERE agent_id = ? AND kind IN (" + kinds.map(() => "?").join(",") + ")")
      .all(process.argv[2], ...kinds)
      .find((o) => o.status === "running" || o.status === "interrupted" || (o.status === "held" && heldHalf.includes(o.kind))
        || after(o.began) || (after(o.changed) && !(o.status === "held" && o.kind === "migrate")));
    if (op) console.log(said[op.kind]);' "$DB_PATH" "$id" "${2:-}" 2>/dev/null || true
}
# The time an archive begins, for `replacing`: a second early, so an op
# recorded in the same second counts as begun during it.
archive_began() { echo $(( $(date +%s) * 1000 - 1000 )); }

# What every agent rebuilds by itself, left out of the tarball — about a
# third of the raw volume data (review, 2026-09-29). Each was checked against
# the OpenClaw source in the image and the live volumes before it went here:
#   .openclaw/cache/control-ui-assets  a copy of the Control UI shipped in the
#       image; the gateway re-publishes it on every start (and OpenClaw's own
#       `openclaw backup` skips it). 54 MB per agent.
#   .openclaw/tmp                      per-process scratch and lock files
#       (plugin-captures is removed on exit; `openclaw backup` skips tmp/).
#   .npm                               npm's download cache only — global
#       installs live in ~/.npm-global and plugins in .openclaw/npm, both kept.
#   .cache/pip                         pip's HTTP download cache; installed
#       packages live elsewhere. The rest of .cache stays: puppeteer browsers,
#       the Claude CLI's files and the like are not ours to call regenerable.
# --anchored: the patterns match only at the volume root, so a project's own
# .npm or .cache/pip inside the workspace is still backed up.
TAR_EXCLUDES="--anchored --exclude=./.openclaw/cache/control-ui-assets --exclude=./.openclaw/tmp --exclude=./.npm --exclude=./.cache/pip"

while IFS= read -r vol; do
  [ -n "$vol" ] || continue
  # No agent uses it: say so and leave it out, or a pre-rename leftover rides
  # along in every set for good (review, 2026-09-29). Remove it by hand after
  # a look: docker volume rm <name>.
  if [ -n "$known" ] && ! grep -qxF -- "$vol" <<<"$known"; then
    echo "  • $vol: no agent uses it — not backed up (docker volume rm $vol once you have looked)"
    orphan_list="$orphan_list $vol"
    continue
  fi
  # Its agent lives on another machine now: this is the copy a move left
  # behind (its clean-up failed), as of the day it moved. Taken under the
  # agent's name it stood in for the runner's copy whenever that one was not
  # taken, and a restore rolled the agent's memory back to the move
  # (2026-10-09). Only the registry's word that the agent is HERE takes a
  # volume; the runner's copy is read below.
  if [ -n "$known" ] && [[ " $expected $expected_failed " != *" $vol "* ]]; then
    echo "  • $vol: its agent lives on another machine now — this machine's copy is left from before the move, not backed up (docker volume rm $vol once you have looked)"
    orphan_list="$orphan_list $vol"
    continue
  fi
  why="$(replacing "$vol")"
  if [ -n "$why" ]; then
    echo "  ✗ $vol: its agent is in the middle of $why, which replaces its files — not in this set (the next backup takes it)" >&2
    failed=$((failed + 1))
    replacing_n=$((replacing_n + 1))
    replacing_list="$replacing_list $vol"
    failed_list="$failed_list $vol"
    continue
  fi
  began="$(archive_began)"
  # Read-only mount; tar from inside a throwaway container so we never need
  # root on the host to reach /var/lib/docker. Run as root so it can read
  # uid-1000 volume files on ANY host (macOS uid is 501), then chown the
  # output to the invoking user and umask 077 so the tarball is host-owned
  # and never world-readable, even on the failure path.
  # GNU tar exits 1 for "file changed as we read it" — expected on a live
  # volume, and the archive is still usable. Only >1 is a hard failure, and
  # one bad volume must not abort the rest of the run.
  # Written as .part and renamed once whole: a <volume>.tgz in a set is
  # always a finished archive (a failed tar left a torn one under the real
  # name, which the retention below would have trusted).
  rc=0
  # Named and labelled as the app's one-shots are, so a failed client's
  # container can be removed (reap_oneshot); with no network, as theirs: on
  # docker's bridge, a "<prefix>-…" name was taken by `hatchabot doctor` for
  # an agent left on the shared network.
  oneshot="|${PREFIX}-bk-$$-$RANDOM$RANDOM"
  hand_over="chown $(id -u):$(id -g) '/out/$vol.tgz.part' 2>/dev/null;"
  if [ "$ROOTLESS" = 1 ]; then hand_over=""; fi
  # No more than what is left of the run's six hours (a minute at least):
  # one that hangs fails, and the run goes on. Not an hour: a big volume on
  # a slow disk took longer than that, and failed every night though Docker
  # was answering (review of HB-0923).
  left=$((RUN_LIMIT_SEC - SECONDS)); [ "$left" -ge 60 ] || left=60
  # --sig-proxy=false: a TERM (the time limit's, or the app's) ends the client.
  # Passed on, it reached the archive's shell, PID 1 in the container, which
  # ignores it: the client waited for -k's KILL, and its exit 137 read as a
  # failed archive, not one that took too long (review of HB-0923). What it
  # leaves running is removed (reap_oneshot).
  ${TL:+$TL $left} docker run --rm --name "${oneshot#|}" --label "hatchabot.oneshot=$PREFIX" --sig-proxy=false --network none --user root -v "$vol:/data:ro" -v "$DEST:/out" "$IMAGE" \
    bash -c "umask 077 && tar czf '/out/$vol.tgz.part' $TAR_EXCLUDES -C /data . ; rc=\$?; $hand_over exit \$rc" || rc=$?
  if [ -n "$TL" ] && [ "$rc" -eq 124 ]; then echo "  ✗ $vol: archiving it was still going at this run's six-hour limit — stopped (is Docker answering? docker info)" >&2; fi
  # A client that failed or was killed may have left its container writing
  # the .part: it is gone before the file is.
  if [ "$rc" -gt 1 ]; then reap_oneshot; fi
  oneshot=""
  # One this user cannot read back is no backup, whatever docker said: a remapped
  # daemon this script does not know of, or a chown that went wrong (HB-0406). Asked
  # before the rename, so it cannot replace an earlier whole archive of the day.
  if [ "$rc" -le 1 ] && [ -f "$DEST/$vol.tgz.part" ] && [ ! -r "$DEST/$vol.tgz.part" ]; then
    echo "  ✗ $vol: docker wrote the archive as uid $(LC_ALL=C ls -ln "$DEST/$vol.tgz.part" 2>/dev/null | awk '{print $3}'), and $(id -un) cannot read it (a remapped or rootless Docker?) — not in this set" >&2
    rm -f "$DEST/$vol.tgz.part" || true
    failed=$((failed + 1))
    failed_list="$failed_list $vol"
    continue
  fi
  why=""; if [ "$rc" -le 1 ] && [ -f "$DEST/$vol.tgz.part" ]; then why="$(replacing "$vol" "$began")"; fi
  if [ -n "$why" ]; then
    rm -f "$DEST/$vol.tgz.part"
    echo "  ✗ $vol: while it was being copied, $why began on its agent, so this copy may be half replaced — not kept (the next backup takes it)" >&2
    failed=$((failed + 1))
    replacing_n=$((replacing_n + 1))
    replacing_list="$replacing_list $vol"
    failed_list="$failed_list $vol"
    continue
  fi
  if [ "$rc" -gt 1 ] || [ ! -f "$DEST/$vol.tgz.part" ] || ! mv -f "$DEST/$vol.tgz.part" "$DEST/$vol.tgz"; then
    rm -f "$DEST/$vol.tgz.part"
    echo "  ✗ $vol failed (exit $rc)" >&2
    failed=$((failed + 1))
    failed_list="$failed_list $vol"
    continue
  fi
  # Already 0600 from the in-container umask; this is belt-and-suspenders and
  # must not abort the run (a root-owned tarball after a chown hiccup can't be
  # chmod'd by the invoking user, but it's already 600).
  chmod 600 "$DEST/$vol.tgz" 2>/dev/null || true
  echo "  ✓ $vol → $DEST/$vol.tgz"
  count=$((count + 1))
  add_captured "$vol"
done <<EOF
$vols
EOF

# Every agent on this machine must be in the set. One whose volume docker did
# not list made a set that said complete and pruned that agent's older sets
# (issue #2): now it is named, counted as failed, and nothing is pruned.
# This run's own captures: one whole from this morning is no answer to a volume docker no longer has.
for vol in $expected; do
  case " $this_run $failed_list " in *" $vol "*) continue ;; esac
  echo "  ✗ $vol: an agent on this machine uses it, but docker has no ${PREFIX}-* volume by that name (removed, or HATCHABOT_PREFIX set wrong?) — not in this set" >&2
  missing_list="$missing_list $vol"
  failed=$((failed + 1))
  failed_list="$failed_list $vol"
done
for vol in $expected_failed; do
  case " $this_run $failed_list " in *" $vol "*) continue ;; esac
  echo "  • $vol: its agent failed to start and has no volume — nothing to back up"
done

# Agents on a runner (another machine's Docker, `docker -H ssh://…`): their
# volumes are not in `docker volume ls` here, so they were in no set at all —
# and since 2026-09-29 the app said so, every night (2026-10-06). Each is read
# over the same connection a Move uses, read-only, by alpine's tar (busybox:
# the excludes match at the volume root only, like --anchored), into the same
# <volume>.tgz a restore reads. A runner that does not answer (a laptop
# asleep) is SKIPPED, not failed: it must not stop the pruning of this
# machine's sets, and its agents stay "not covered" in the app — the retention
# below keeps each one's newest copy however old it gets. A runner that
# answers but whose archive fails (tar, a torn gzip, no alpine) is FAILED, as
# a local volume is: that is a broken backup, not a sleeping laptop
# (2026-10-09). The list of them ($remote) was read from the registry above.
if [ -n "$remote" ]; then
  # -k: a docker client that passes the TERM on and waits is killed.
  T="${TO:+$TO -k 10}"
  down_hosts=" "
  while IFS=$'\t' read -r rhost vol rstate; do
    [ -n "$vol" ] || continue
    if [[ "$down_hosts" == *" $rhost "* ]] || ! ${T:+$T 30} docker -H "$rhost" $(tls_args "$rhost") version </dev/null >/dev/null 2>&1; then
      if [[ "$down_hosts" != *" $rhost "* ]]; then
        echo "  • ${rhost#*://}: not answering (asleep or offline?) — its agents are not in this set" >&2
        down_hosts="$down_hosts$rhost "
      fi
      skipped_list="$skipped_list $vol"
      continue
    fi
    why="$(replacing "$vol")"
    if [ -n "$why" ]; then
      echo "  ✗ $vol on ${rhost#*://}: its agent is in the middle of $why, which replaces its files — not in this set (the next backup takes it)" >&2
      failed=$((failed + 1))
      replacing_n=$((replacing_n + 1))
      replacing_list="$replacing_list $vol"
      failed_list="$failed_list $vol"
      continue
    fi
    # The volume must be there before it is mounted: `run -v <name>:…` makes
    # a missing one, so an empty archive was counted as the agent's backup and
    # an empty volume was left on the runner (2026-10-09). Missing is missing,
    # as for a local agent; one whose first start failed has none to take.
    rc=0
    inspect="$(${T:+$T 60} docker -H "$rhost" $(tls_args "$rhost") volume inspect --format '{{.Name}}' "$vol" </dev/null 2>&1)" || rc=$?
    if [ "$rc" -ne 0 ]; then
      if [ "$rstate" = FAILED ] && [[ "$inspect" == *"o such volume"* ]]; then
        echo "  • $vol: its agent failed to start and has no volume — nothing to back up"
        continue
      fi
      if [[ "$inspect" == *"o such volume"* ]]; then
        echo "  ✗ $vol: an agent on ${rhost#*://} uses it, but that runner has no volume by that name — not in this set" >&2
        missing_list="$missing_list $vol"
      else
        echo "  ✗ $vol on ${rhost#*://}: could not look it up (exit $rc) — not in this set" >&2
      fi
      failed=$((failed + 1))
      failed_list="$failed_list $vol"
      continue
    fi
    rc=0
    began="$(archive_began)"
    # Named and labelled as the app's one-shots are (the app's sweep, at boot
    # and every 10 minutes, removes one left exited, on runners too), so a
    # failed run can remove it by name. Read-only: a restore leaves it running.
    oneshot="$rhost|${PREFIX}-bk-$$-$RANDOM$RANDOM"
    # </dev/null: over ssh, docker would read the rest of this loop's list.
    # shellcheck disable=SC2046,SC2086  # the TLS flag and the excludes are separate words
    # --sig-proxy=false, as on this machine: a TERM ends the client, not passed to tar.
    ${T:+$T 3600} docker -H "$rhost" $(tls_args "$rhost") run --rm --name "${oneshot#*|}" --label "hatchabot.oneshot=$PREFIX" --sig-proxy=false --network none -v "$vol:/vol:ro" alpine \
      tar cz ${TAR_EXCLUDES#--anchored } -C /vol . </dev/null > "$DEST/$vol.tgz.part" || rc=$?
    # A client that failed or timed out may have left its container running
    # on the runner: it is gone before the next volume, or the run ends.
    if [ "$rc" -ne 0 ]; then reap_oneshot; fi
    oneshot=""
    # busybox tar has no "changed as we read it" exit 1: anything but 0 failed.
    if [ "$rc" -ne 0 ] || ! gzip -t "$DEST/$vol.tgz.part" 2>/dev/null; then
      rm -f "$DEST/$vol.tgz.part"
      echo "  ✗ $vol on ${rhost#*://} failed (exit $rc) — not in this set" >&2
      failed=$((failed + 1))
      failed_list="$failed_list $vol"
      continue
    fi
    why="$(replacing "$vol" "$began")"
    if [ -n "$why" ]; then
      rm -f "$DEST/$vol.tgz.part"
      echo "  ✗ $vol on ${rhost#*://}: while it was being copied, $why began on its agent, so this copy may be half replaced — not kept (the next backup takes it)" >&2
      failed=$((failed + 1))
      replacing_n=$((replacing_n + 1))
      replacing_list="$replacing_list $vol"
      failed_list="$failed_list $vol"
      continue
    fi
    mv -f "$DEST/$vol.tgz.part" "$DEST/$vol.tgz"
    chmod 600 "$DEST/$vol.tgz"
    echo "  ✓ $vol (on ${rhost#*://}) → $DEST/$vol.tgz"
    count=$((count + 1))
    add_captured "$vol"
  done <<REMOTE
$remote
REMOTE
fi

# Prune ONLY after confirming this backup is complete — a failing/partial run
# must never delete the last good snapshots. Restricted to our own date-named
# directories, since the destination may be a shared path (e.g. a NAS).
# But for volumes left out because their files were being replaced: a held
# restore can last days, and nothing on the install was pruned while it did
# (review of HB-0922). The retention below keeps each agent's newest copy
# however old, that agent's among them; the set still says incomplete.
# A set with no volume to take is the database alone, and complete: the
# registry read, no agent on this machine or a runner but those whose failed
# first start left no volume (said above). Those are known, so the retention
# keeps the newest copy of each; counted incomplete, an install of only such
# agents pruned nothing, night after night (review of HB-1110).
NOTHING_TO_TAKE=""
[ -z "$registry_read" ] || [ -n "$expected$remote" ] || NOTHING_TO_TAKE=1
if [ "$((failed - replacing_n))" -gt 0 ] || { [ "$count" -eq 0 ] && [ -z "$NOTHING_TO_TAKE" ]; }; then
  if [ "$count" -eq 0 ] && [ "$failed" -eq 0 ] && [ -n "$skipped_list" ]; then
    echo "✗ No volume captured: every runner was asleep — incomplete backup, nothing pruned." >&2
  else
    echo "✗ $failed volume(s) failed or missing, $count succeeded — incomplete backup, nothing pruned." >&2
  fi
  exit 1
fi
# Every volume taken, but the saved key reads none of the secrets (above).
if [ -n "$KEY_UNREAD" ]; then
  echo "✗ $count volume(s) captured, but the saved key decrypts none of the backed-up secrets — incomplete backup, nothing pruned." >&2
  exit 1
fi

# Retention, per agent: a set older than KEEP_DAYS goes unless it holds the
# newest copy of an agent's volume. A runner asleep at backup time is skipped
# night after night while each set says complete, and the plain age rule then
# deleted every set holding that agent (2026-10-09). An agent the registry no
# longer has (deleted) is not held; with no agents to read there, a volume
# docker still has is, and so is any the registry does not say was deleted.
# A new machine set up with the old one's key and backups folder, its
# database not restored yet, read no agent at all: its first run took the
# set for complete and pruned the old machine's sets, the only copies of its
# agents' volumes (review of HB-1110). Their newest copies stay while the
# registry knows no agent at all, and once it knows one too (an agent made
# there before the restore): it pruned them by age then, the only copies of
# the old machine's agents (HB-1380). A volume this registry never listed,
# neither an agent's here nor a deleted one's, keeps its newest copy until
# a restored database names it (its agent's, or deleted) or the owner
# deletes the set.
# Sets are dated directories, so newest first is reverse name order.
newer_vols=" "
old_sets="$(find "$BASE" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??' -mtime "+$KEEP_DAYS")"
while IFS= read -r set; do
  [ -n "$set" ] || continue
  # Another install's set (a shared base) is not this run's to prune. A set
  # from before the owner file is the install's whose key it saved: two
  # installs that wrote the same day's sets in turn left the later one's key
  # in each, and the other install pruned those, the later one's only copies
  # once its own runs stopped at the owner file (HB-0280).
  so="$(set_owner "$set" "$owner")"
  if [ -n "$so" ] && [ "$so" != "$owner" ]; then continue; fi
  if grep -qxF -- "$set" <<<"$old_sets"; then
    held=""; unlisted=""; listed=0
    for tgz in "$set"/*.tgz; do
      [ -e "$tgz" ] || continue
      v="$(basename "$tgz" .tgz)"
      [[ "$newer_vols" == *" $v "* ]] && continue
      if [ -n "$known" ] && grep -qxF -- "$v" <<<"$known"; then
        held="$held $v"; listed=1
      elif [ -n "$registry_read" ] && ! grep -qxF -- "$v" <<<"$deleted_vols"; then
        held="$held $v"; unlisted="$unlisted $v"
      elif [ -z "$known" ] && grep -qxF -- "$v" <<<"$vols"; then
        held="$held $v"; listed=1
      fi
    done
    if [ -n "$held" ]; then
      echo "  • kept $(basename "$set") past $KEEP_DAYS days: the newest copy of$held"
      [ -z "$unlisted" ] || echo "    (no agent here has had$unlisted: another machine's, or a database not restored yet; kept until a restored database names it, or you delete the set)"
      # Kept for those alone: recorded, names as docker gives them only, and
      # a set named as a date alone, as doctor reads one (the record is JSON
      # written by hand: a folder named 20"}-01-02, which the find takes,
      # made the whole record no JSON: review of HB-1380).
      set_name="$(basename "$set")"
      if [ -n "$unlisted" ] && [ "$listed" = 0 ] && [[ "$set_name" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}$ ]]; then
        names=""; for v in $unlisted; do if [[ "$v" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then names="$names $v"; fi; done
        kept_unlisted="$kept_unlisted${kept_unlisted:+,}\"$set_name\":$(json_list "$names")"
      fi
    else
      rm -rf "$set"
    fi
  fi
  for tgz in "$set"/*.tgz; do if [ -e "$tgz" ]; then newer_vols="$newer_vols$(basename "$tgz" .tgz) "; fi; done
done < <(find "$BASE" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??' | sort -r)
retention_ran=1
if [ "$replacing_n" -gt 0 ]; then
  echo "✗ $replacing_n volume(s) left out while their files were being replaced, $count succeeded — incomplete backup; older sets pruned as usual, each agent's newest copy kept." >&2
  exit 1
fi
echo "Backed up $count volume(s) to $DEST (keeping $KEEP_DAYS days)"
