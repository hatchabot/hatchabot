#!/usr/bin/env bash
# Prove a backup restores — without touching the live system.
#
# An untested backup is a hope, not a backup. This drill takes a dated backup
# directory (newest complete by default) and verifies every part of it:
#
#   1. The database copy passes SQLite's integrity check and still holds the
#      registry (agents, profiles, channels, secrets are countable).
#   2. The saved HATCHABOT_SECRET_KEY actually decrypts a secret from that
#      database — the one failure you cannot recover from later. (In memory,
#      never printed or used: the one credential the drill touches, and it is
#      the backup's own copy, not the live .env.)
#   3. Every agent's archive is read whole and holds the tree OpenClaw boots
#      from, and each is restored into a throwaway volume, one at a time.
#
# Each restore is isolated (docs/recovery-readiness-design.md): a container
# with no network, 1 GB of memory, one CPU, no new privileges and bash as its
# entrypoint (nothing of OpenClaw starts: no bot polls, no AI call), with only
# that one archive mounted read-only (never the database or the key), into a
# fresh labelled volume removed after it. Each restore has 15 minutes, all of
# them an hour; what the hour did not reach is checked by reading only.
#
# Every run writes a record, <backups>/drills/<UTC time>.json (the newest 30
# kept): the set, each volume checked and how, pass or fail, time, duration.
# The app reads them (Settings → Backups, each agent's Recovery row).
#
#   ./scripts/restore-drill.sh                 # newest complete backup
#   ./scripts/restore-drill.sh <backup-dir>    # a specific one
set -euo pipefail
[ -x "$(dirname "$0")/../.node/bin/node" ] && PATH="$(cd "$(dirname "$0")/.." && pwd)/.node/bin:$PATH" && export PATH  # a bundle install's own Node (install.sh)
cd "$(dirname "$0")/.."

# Pre-rename .env files: alias AGENTCLAW_* → HATCHABOT_* (existing HATCHABOT_* wins).
for v in $(compgen -A variable AGENTCLAW_ 2>/dev/null); do n="HATCHABOT_${v#AGENTCLAW_}"; [ -n "${!n+x}" ] || export "$n=${!v}"; done
BASE="${HATCHABOT_BACKUP_DIR:-$HOME/hatchabot-backups}"
[ -d "$BASE" ] || [ -n "${HATCHABOT_BACKUP_DIR:-}" ] || { [ -d "$HOME/agentclaw-backups" ] && BASE="$HOME/agentclaw-backups"; }
IMAGE="${HATCHABOT_IMAGE:-hatchabot-runtime:latest}"
# Who started it, for the record: the app's "Run a drill now" (app), its
# schedule (scheduled), or a person or the live test at a shell (command).
TRIGGER="${HATCHABOT_DRILL_TRIGGER:-command}"
case "$TRIGGER" in app|scheduled|command) ;; *) TRIGGER=command ;; esac
# The limits each throwaway restore runs under (the record repeats them).
LIM_MEMORY=1g
LIM_CPUS=1
PER_RESTORE_SEC=900
ALL_RESTORES_SEC=3600
umask 077

# A set's own record (backup-status.json, written by backup-volumes.sh) says
# whether its run finished with every volume in. A set from before the record
# has none and is taken as it is.
set_state() { local s; s="$(grep -m1 -o '"state":"[a-z]*"' "$1/backup-status.json" 2>/dev/null || true)"; s="${s#\"state\":\"}"; printf '%s' "${s%\"}"; }

RECORD_DIR=""
SET_DATE=""
SET_STATE=""
REASON=""
started="$(date -u +%FT%TZ)"
db_result=missing
key_result=missing
fail=0
LOCK=""
SCRATCH=""
DRILL_VOL=""
DRILL_CT=""
# Per archive, parallel arrays (bash 3.2 on macOS has no associative ones):
# name, path, size, readable/layout/restored (1, 0, or "" for not tried), note.
VOL_NAMES=(); VOL_TGZ=(); VOL_BYTES=(); VOL_READ=(); VOL_LAYOUT=(); VOL_REST=(); VOL_NOTE=()

tri() { case "$1" in 1) printf true ;; 0) printf false ;; *) printf null ;; esac; }
write_record() {
  [ -n "$RECORD_DIR" ] && [ -n "$LOCK" ] || return 0
  local vols="" i=0 r result
  while [ "$i" -lt "${#VOL_NAMES[@]}" ]; do
    r=passed
    if [ "${VOL_READ[$i]}" != 1 ] || [ "${VOL_LAYOUT[$i]}" != 1 ] || [ "${VOL_REST[$i]}" = 0 ]; then r=failed; fi
    vols="$vols${vols:+,}$(printf '{"volume":"%s","readable":%s,"layout":%s,"restored":%s,"note":"%s","result":"%s"}' \
      "${VOL_NAMES[$i]}" "$(tri "${VOL_READ[$i]}")" "$(tri "${VOL_LAYOUT[$i]}")" "$(tri "${VOL_REST[$i]}")" "${VOL_NOTE[$i]}" "$r")"
    i=$((i + 1))
  done
  result=passed; [ "$fail" -eq 0 ] || result=failed
  local file
  file="$RECORD_DIR/$(date -u +%Y-%m-%dT%H-%M-%SZ).json"
  printf '{"version":1,"set":"%s","setState":"%s","startedAt":"%s","finishedAt":"%s","durationSec":%d,"trigger":"%s","result":"%s","reason":"%s","database":"%s","key":"%s","volumes":[%s],"isolation":{"network":"none","memory":"%s","cpus":"%s"}}\n' \
    "$SET_DATE" "$SET_STATE" "$started" "$(date -u +%FT%TZ)" "$SECONDS" "$TRIGGER" "$result" "$REASON" "$db_result" "$key_result" "$vols" "$LIM_MEMORY" "$LIM_CPUS" \
    > "$file.tmp" && mv -f "$file.tmp" "$file" || true
  # The newest 30 records are kept.
  find "$RECORD_DIR" -maxdepth 1 -type f -name '20*.json' | sort -r | tail -n +31 | while IFS= read -r old; do rm -f "$old"; done
}
cleanup() {
  [ -n "$DRILL_CT" ] && docker rm -f "$DRILL_CT" >/dev/null 2>&1 || true
  [ -n "$DRILL_VOL" ] && docker volume rm -f "$DRILL_VOL" >/dev/null 2>&1 || true
  [ -n "$SCRATCH" ] && rm -rf "$SCRATCH"
}
finish() {
  local rc=$?
  [ "$rc" -eq 0 ] || fail=1
  write_record
  cleanup
  [ -n "$LOCK" ] && rm -rf "$LOCK"
  exit "$rc"
}
# One drill at a time: the schedule and "Run a drill now" (or the live test)
# would restore into docker side by side. The backup script's lock: mkdir is
# atomic everywhere, the lock holds the pid, a dead holder's lock is taken over.
take_lock() {
  mkdir -m 700 -p "$RECORD_DIR" 2>/dev/null || { RECORD_DIR=""; return 0; }
  chmod 700 "$RECORD_DIR" 2>/dev/null || true
  if ! mkdir "$RECORD_DIR/.lock" 2>/dev/null; then
    local holder; holder="$(cat "$RECORD_DIR/.lock/pid" 2>/dev/null || true)"
    if { [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; } || { [ -z "$holder" ] && [ -z "$(find "$RECORD_DIR/.lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; }; then
      echo "✗ Another restore drill${holder:+ (pid $holder)} is running — this one stops; that drill's record will say how it went." >&2
      exit 1
    fi
    echo "  • an earlier drill that was killed left its lock — taking it over" >&2
  fi
  echo "$$" > "$RECORD_DIR/.lock/pid"
  LOCK="$RECORD_DIR/.lock"
}
trap finish EXIT

if [ $# -ge 1 ]; then
  BACKUP="$1"
  [ -d "$BACKUP" ] || { echo "✗ No such backup directory: $BACKUP" >&2; exit 1; }
  BACKUP="$(cd "$BACKUP" && pwd)"
  RECORD_DIR="$(dirname "$BACKUP")/drills"
  take_lock
  st="$(set_state "$BACKUP")"
  if [ -n "$st" ] && [ "$st" != complete ]; then echo "  ⚠ $(basename "$BACKUP") is not a complete set (its run says \"$st\") — drilling it anyway, as asked." >&2; fi
else
  # The base checked first: under pipefail a find on a missing directory
  # ended the script with find's own error and not this one (2026-10-09).
  [ -d "$BASE" ] || { echo "✗ No backups directory at $BASE (HATCHABOT_BACKUP_DIR) — no backup has run yet, or it writes elsewhere." >&2; exit 1; }
  RECORD_DIR="$(cd "$BASE" && pwd)/drills"
  take_lock
  # The newest set whose run finished: a partial or still-running one is not
  # what a restore would use, and drilling it proved nothing (2026-10-09).
  BACKUP=""
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    st="$(set_state "$d")"
    if [ -z "$st" ] || [ "$st" = complete ]; then BACKUP="$(cd "$d" && pwd)"; break; fi
    echo "  • $(basename "$d") is not a complete set (its run says \"$st\") — passing over it" >&2
  done < <(find "$BASE" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??' | sort -r)
  [ -n "$BACKUP" ] || { REASON=no-complete-set; echo "✗ No complete backup set under $BASE" >&2; exit 1; }
fi
SET_DATE="$(basename "$BACKUP")"
SET_STATE="$(set_state "$BACKUP")"
echo "Drilling restore from: $BACKUP"

SCRATCH="$(mktemp -d)"
chmod 700 "$SCRATCH"

# --- 1. The database ---------------------------------------------------------
DBFILE="$BACKUP/hatchabot.sqlite"; [ -f "$DBFILE" ] || DBFILE="$BACKUP/agentclaw.sqlite"   # pre-rename backups
if [ ! -f "$DBFILE" ]; then
  # The archives are still checked: each agent's own verdict stands apart.
  echo "✗ Backup has no hatchabot.sqlite — the registry was not captured." >&2
  fail=1
else
  cp "$DBFILE" "$SCRATCH/db.sqlite"
  if node -e '
    const Database = require("better-sqlite3");
    const db = new Database(process.argv[1], { readonly: true });
    const ok = db.pragma("integrity_check", { simple: true });
    if (ok !== "ok") { console.error("integrity_check: " + ok); process.exit(1); }
    const n = (sql) => db.prepare(sql).get().c;
    console.log(`  ✓ database intact: ${n("SELECT COUNT(*) c FROM agents WHERE state != \x27DELETED\x27")} agents, ` +
      `${n("SELECT COUNT(*) c FROM ai_profiles")} AI profiles, ` +
      `${n("SELECT COUNT(*) c FROM channels")} channels, ` +
      `${n("SELECT COUNT(*) c FROM secrets")} secrets`);
  ' "$SCRATCH/db.sqlite"; then db_result=ok; else db_result=failed; echo "✗ Database failed verification" >&2; fail=1; fi
fi

# --- 2. The secret key -------------------------------------------------------
# Decrypt a real secret from the backed-up DB with the backed-up key. If this
# step ever fails, the backup contains bot tokens nobody can read back — the
# exact disaster the key copy exists to prevent.
if [ ! -f "$BACKUP/secret-key.env" ]; then
  echo "✗ Backup has no secret-key.env — its secrets are unrecoverable without the live .env." >&2
  fail=1
elif [ "$db_result" != ok ]; then
  key_result=failed
  echo "✗ The key could not be tried: the database copy did not pass" >&2
  fail=1
else
  # Read the key value safely: it may be a passphrase with spaces or glob
  # characters (keyFromEnv stretches any passphrase), so an unquoted
  # `env $(grep …)` would word-split or glob-expand it and test the wrong
  # string. Strip the KEY= prefix and any shell quoting, pass it as one arg.
  key_line="$(grep -m1 -E '^(HATCHABOT|AGENTCLAW)_SECRET_KEY=' "$BACKUP/secret-key.env" || true)"   # pre-rename sets use the old key name
  key_val="${key_line#*=}"
  case "$key_val" in
    "'"*"'") key_val="${key_val#\'}"; key_val="${key_val%\'}" ;;   # strip single quotes
    '"'*'"') key_val="${key_val#\"}"; key_val="${key_val%\"}" ;;   # strip double quotes
  esac
  if HATCHABOT_DRILL_DB="$SCRATCH/db.sqlite" HATCHABOT_REPO="$(pwd)" \
    HATCHABOT_SECRET_KEY="$key_val" \
    ./node_modules/.bin/tsx -e '
      import Database from "better-sqlite3";
      async function main() {
        // Absolute dynamic import: tsx -e cannot resolve repo-relative paths.
        const { LocalSecretStore } = await import(`${process.env.HATCHABOT_REPO}/src/secrets/localSecretStore.js`);
        const db = new Database(process.env.HATCHABOT_DRILL_DB!, { readonly: true });
        const row = db.prepare("SELECT ref FROM secrets LIMIT 1").get() as { ref: string } | undefined;
        if (!row) { console.log("  ✓ key parses (no secrets in store to decrypt)"); return; }
        const store = new LocalSecretStore(db, LocalSecretStore.keyFromEnv());
        const value = await store.get(row.ref);
        if (!value) throw new Error("empty secret");
        console.log(`  ✓ backed-up key decrypts ${row.ref} (${value.length} chars — not shown)`);
      }
      main().catch((e) => { console.error(String(e)); process.exit(1); });
    '; then key_result=ok; else key_result=failed; echo "✗ The backed-up key could NOT decrypt the backed-up secrets" >&2; fail=1; fi
fi

# --- 3. The archives: each read whole, its layout looked for ------------------
# Portable file size: GNU `stat -c %s`, BSD/macOS `stat -f %z` (the drill runs
# on macOS hosts too, where the old GNU-only form aborted the whole script).
filesize() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; }

seen_tgz=" "
# Match both modern (…-slug-<id>-vol.tgz) and legacy (…-vol-<short>.tgz) names.
# The two globs can overlap (a slug containing "vol-"), so dedup by path.
for tgz in "$BACKUP"/*-vol.tgz "$BACKUP"/*-vol-*.tgz; do
  [ -e "$tgz" ] || continue
  case "$seen_tgz" in *" $tgz "*) continue ;; esac
  seen_tgz="$seen_tgz$tgz "
  name="$(basename "$tgz" .tgz | tr -d '"\\')"   # it goes into the JSON record as it is
  readable=0; layout=0; note=""
  # The whole gzip stream and tar listing: a torn or truncated archive fails here.
  if tar tzf "$tgz" > "$SCRATCH/listing" 2>/dev/null; then
    readable=1
    # The tree OpenClaw boots from: files (not only directories) under
    # agents/, in $HOME/.openclaw (new layout) or /data/agents (old).
    if grep -qE '^(\./)?(\.openclaw/)?agents/.*[^/]$' "$SCRATCH/listing"; then layout=1; else note=layout; fi
  else
    note=unreadable
  fi
  VOL_NAMES+=("$name"); VOL_TGZ+=("$tgz"); VOL_BYTES+=("$(filesize "$tgz")")
  VOL_READ+=("$readable"); VOL_LAYOUT+=("$layout"); VOL_REST+=(""); VOL_NOTE+=("$note")
  if [ "$readable" = 1 ] && [ "$layout" = 1 ]; then
    echo "  ✓ $name: archive reads whole, OpenClaw layout inside"
  elif [ "$readable" = 1 ]; then
    echo "  ✗ $name: archive reads, but holds no files under agents/ — not a usable restore" >&2; fail=1
  else
    echo "  ✗ $name: unreadable archive" >&2; fail=1
  fi
done
rm -f "$SCRATCH/listing"

# A backup with NO volume tarballs is not a passing backup — it is the exact
# silent-empty case this drill exists to catch. (The DB alone restores the
# registry but no agent remembers anything.)
if [ "${#VOL_NAMES[@]}" -eq 0 ]; then
  echo "  ✗ No volume archives in this backup — agent state was not captured." >&2
  fail=1
fi

# --- 4. Each archive restored into a throwaway volume --------------------------
# Largest first (the old drill's one restore, so a short hour still proves it),
# then by name. Only archives that read whole with the layout are tried.
order=""
largest=-1; largest_bytes=-1
i=0
while [ "$i" -lt "${#VOL_NAMES[@]}" ]; do
  if [ "${VOL_READ[$i]}" = 1 ] && [ "${VOL_LAYOUT[$i]}" = 1 ] && [ "${VOL_BYTES[$i]}" -gt "$largest_bytes" ]; then largest=$i; largest_bytes=${VOL_BYTES[$i]}; fi
  i=$((i + 1))
done
if [ "$largest" -ge 0 ]; then
  order="$largest"
  i=0
  while [ "$i" -lt "${#VOL_NAMES[@]}" ]; do
    if [ "$i" -ne "$largest" ] && [ "${VOL_READ[$i]}" = 1 ] && [ "${VOL_LAYOUT[$i]}" = 1 ]; then order="$order $i"; fi
    i=$((i + 1))
  done
fi

if [ -n "$order" ]; then
  if ! docker version >/dev/null 2>&1; then
    echo "  ✗ docker is not answering — the archives were read, but none could be restored into a throwaway volume." >&2
    for i in $order; do VOL_NOTE[$i]=nodocker; done
    fail=1
  else
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then IMAGE="debian:stable-slim"; fi
    # What a killed drill left behind (its container, its volume) goes first.
    for c in $(docker ps -aq --filter label=hatchabot.restore-drill=1 2>/dev/null || true); do docker rm -f "$c" >/dev/null 2>&1 || true; done
    for v in $(docker volume ls -q --filter label=hatchabot.restore-drill=1 2>/dev/null || true) \
             $(docker volume ls -q 2>/dev/null | grep '^acl-restore-drill-' || true); do
      docker volume rm -f "$v" >/dev/null 2>&1 || true
    done
    T=""; command -v timeout >/dev/null 2>&1 && T="timeout"
    restore_start=$SECONDS
    n=0
    for i in $order; do
      name="${VOL_NAMES[$i]}"
      if [ $((SECONDS - restore_start)) -ge "$ALL_RESTORES_SEC" ]; then
        VOL_NOTE[$i]=budget
        echo "  • $name: not restored this time — the drill's hour for restores is used up (its archive was read whole)"
        continue
      fi
      n=$((n + 1))
      DRILL_VOL="hatchabot-restore-drill-$$-$n"
      DRILL_CT="hatchabot-restore-drill-$$-$n"
      rc=0
      docker volume create --label hatchabot.restore-drill=1 "$DRILL_VOL" >/dev/null || rc=$?
      files=""
      if [ "$rc" -eq 0 ]; then
        # As root, then chown — the same rules as the provider's importState:
        # a FRESH volume is root-owned, so extracting as the image's uid-1000
        # user fails on the first mkdir (the new-machine case). The layout
        # check counts files under agents/ in the restored volume.
        files="$(${T:+$T $PER_RESTORE_SEC} docker run --rm --name "$DRILL_CT" --label hatchabot.restore-drill=1 \
          --network none --memory "$LIM_MEMORY" --memory-swap "$LIM_MEMORY" --cpus "$LIM_CPUS" --pids-limit 256 \
          --security-opt no-new-privileges --user root --entrypoint bash \
          -v "$DRILL_VOL:/data" -v "${VOL_TGZ[$i]}:/in/vol.tgz:ro" "$IMAGE" \
          -c 'cd /data && tar xzf /in/vol.tgz --no-same-owner && chown -R 1000:1000 /data && { find /data/.openclaw/agents /data/agents -type f 2>/dev/null | wc -l; }' \
          </dev/null)" || rc=$?
      fi
      docker rm -f "$DRILL_CT" >/dev/null 2>&1 || true
      docker volume rm -f "$DRILL_VOL" >/dev/null 2>&1 || true
      DRILL_CT=""; DRILL_VOL=""
      files="$(printf '%s' "$files" | tr -dc '0-9')"
      if [ "$rc" -eq 124 ]; then
        VOL_REST[$i]=0; VOL_NOTE[$i]=timeout; fail=1
        echo "  ✗ $name: restoring it took longer than $((PER_RESTORE_SEC / 60)) minutes — stopped" >&2
      elif [ "$rc" -ne 0 ]; then
        VOL_REST[$i]=0; VOL_NOTE[$i]=extract; fail=1
        echo "  ✗ $name: failed to extract into a fresh volume (exit $rc)" >&2
      elif [ -z "$files" ] || [ "$files" -eq 0 ]; then
        VOL_REST[$i]=0; VOL_NOTE[$i]=layout; fail=1
        echo "  ✗ $name: restored, but the OpenClaw layout is missing" >&2
      else
        VOL_REST[$i]=1
        echo "  ✓ $name restores: $files files under agents/"
      fi
    done
  fi
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "✅ Restore drill passed — this backup would bring the system back."
else
  echo "❌ Restore drill FAILED — fix this before you need the backup." >&2
  exit 1
fi
