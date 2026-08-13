#!/usr/bin/env bash
# Prove a backup restores — without touching the live system.
#
# An untested backup is a hope, not a backup. This drill takes a dated backup
# directory (newest by default) and verifies every part of it end to end:
#
#   1. The database copy passes SQLite's integrity check and still holds the
#      registry (agents, profiles, channels, secrets are countable).
#   2. The saved AGENTCLAW_SECRET_KEY actually decrypts a secret from that
#      database — the one failure you cannot recover from later.
#   3. Every volume tarball is a readable archive, and the largest one
#      actually restores into a (throwaway) docker volume with the expected
#      OpenClaw layout inside.
#
# Reads the backup, writes only to a scratch dir and a throwaway volume that
# are removed on exit. Run it after any change to the backup pipeline, or
# whenever you want the word "backup" to mean something.
#
#   ./scripts/restore-drill.sh                 # newest backup
#   ./scripts/restore-drill.sh <backup-dir>    # a specific one
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${AGENTCLAW_BACKUP_DIR:-$HOME/agentclaw-backups}"
IMAGE="${AGENTCLAW_IMAGE:-agentclaw-runtime:latest}"

if [ $# -ge 1 ]; then
  BACKUP="$1"
else
  BACKUP="$(find "$BASE" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??' | sort | tail -n1)"
fi
[ -n "$BACKUP" ] && [ -d "$BACKUP" ] || { echo "✗ No backup directory found under $BASE" >&2; exit 1; }
echo "Drilling restore from: $BACKUP"

SCRATCH="$(mktemp -d)"
chmod 700 "$SCRATCH"
DRILL_VOL="acl-restore-drill-$$"
cleanup() {
  rm -rf "$SCRATCH"
  docker volume rm -f "$DRILL_VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail=0

# --- 1. The database ---------------------------------------------------------
if [ ! -f "$BACKUP/agentclaw.sqlite" ]; then
  echo "✗ Backup has no agentclaw.sqlite — the registry was not captured." >&2
  exit 1
fi
cp "$BACKUP/agentclaw.sqlite" "$SCRATCH/db.sqlite"
node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.argv[1], { readonly: true });
  const ok = db.pragma("integrity_check", { simple: true });
  if (ok !== "ok") { console.error("integrity_check: " + ok); process.exit(1); }
  const n = (sql) => db.prepare(sql).get().c;
  console.log(`  ✓ database intact: ${n("SELECT COUNT(*) c FROM agents WHERE state != \x27DELETED\x27")} agents, ` +
    `${n("SELECT COUNT(*) c FROM ai_profiles")} AI profiles, ` +
    `${n("SELECT COUNT(*) c FROM channels")} channels, ` +
    `${n("SELECT COUNT(*) c FROM secrets")} secrets`);
' "$SCRATCH/db.sqlite" || { echo "✗ Database failed verification" >&2; fail=1; }

# --- 2. The secret key -------------------------------------------------------
# Decrypt a real secret from the backed-up DB with the backed-up key. If this
# step ever fails, the backup contains bot tokens nobody can read back — the
# exact disaster the key copy exists to prevent.
if [ ! -f "$BACKUP/secret-key.env" ]; then
  echo "✗ Backup has no secret-key.env — its secrets are unrecoverable without the live .env." >&2
  fail=1
else
  # Read the key value safely: it may be a passphrase with spaces or glob
  # characters (keyFromEnv stretches any passphrase), so an unquoted
  # `env $(grep …)` would word-split or glob-expand it and test the wrong
  # string. Strip the KEY= prefix and any shell quoting, pass it as one arg.
  key_line="$(grep -m1 '^AGENTCLAW_SECRET_KEY=' "$BACKUP/secret-key.env" || true)"
  key_val="${key_line#AGENTCLAW_SECRET_KEY=}"
  case "$key_val" in
    "'"*"'") key_val="${key_val#\'}"; key_val="${key_val%\'}" ;;   # strip single quotes
    '"'*'"') key_val="${key_val#\"}"; key_val="${key_val%\"}" ;;   # strip double quotes
  esac
  AGENTCLAW_DRILL_DB="$SCRATCH/db.sqlite" AGENTCLAW_REPO="$(pwd)" \
    AGENTCLAW_SECRET_KEY="$key_val" \
    ./node_modules/.bin/tsx -e '
      import Database from "better-sqlite3";
      async function main() {
        // Absolute dynamic import: tsx -e cannot resolve repo-relative paths.
        const { LocalSecretStore } = await import(`${process.env.AGENTCLAW_REPO}/src/secrets/localSecretStore.js`);
        const db = new Database(process.env.AGENTCLAW_DRILL_DB!, { readonly: true });
        const row = db.prepare("SELECT ref FROM secrets LIMIT 1").get() as { ref: string } | undefined;
        if (!row) { console.log("  ✓ key parses (no secrets in store to decrypt)"); return; }
        const store = new LocalSecretStore(db, LocalSecretStore.keyFromEnv());
        const value = await store.get(row.ref);
        if (!value) throw new Error("empty secret");
        console.log(`  ✓ backed-up key decrypts ${row.ref} (${value.length} chars — not shown)`);
      }
      main().catch((e) => { console.error(String(e)); process.exit(1); });
    ' || { echo "✗ The backed-up key could NOT decrypt the backed-up secrets" >&2; fail=1; }
fi

# --- 3. The volumes ----------------------------------------------------------
# Portable file size: GNU `stat -c %s`, BSD/macOS `stat -f %z` (the drill runs
# on macOS hosts too, where the old GNU-only form aborted the whole script).
filesize() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; }

count=0
largest=""
largest_bytes=0
# Match both modern (…-slug-<id>-vol.tgz) and legacy (…-vol-<short>.tgz) names.
for tgz in "$BACKUP"/*-vol.tgz "$BACKUP"/*-vol-*.tgz; do
  [ -e "$tgz" ] || continue
  if ! tar tzf "$tgz" >/dev/null 2>&1; then
    echo "  ✗ unreadable archive: $(basename "$tgz")" >&2
    fail=1
    continue
  fi
  count=$((count + 1))
  bytes=$(filesize "$tgz")
  if [ "$bytes" -gt "$largest_bytes" ]; then largest_bytes=$bytes; largest="$tgz"; fi
done

# A backup with NO volume tarballs is not a passing backup — it is the exact
# silent-empty case this drill exists to catch. (The DB alone restores the
# registry but no agent remembers anything.)
if [ "$count" -eq 0 ]; then
  echo "  ✗ No volume archives in this backup — agent state was not captured." >&2
  fail=1
fi
echo "  ✓ $count volume archive(s) readable"

if [ -n "$largest" ]; then
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then IMAGE="debian:stable-slim"; fi
  docker volume create "$DRILL_VOL" >/dev/null
  # As root, then chown — the same rules as the provider's importState: a
  # FRESH volume is root-owned, so extracting as the image's uid-1000 user
  # fails on the first mkdir. This is exactly the disaster-recovery case (new
  # machine, no volumes yet), and the drill's first run caught the documented
  # one-liner getting it wrong.
  if docker run --rm --user root -v "$DRILL_VOL:/data" -v "$BACKUP:/in:ro" "$IMAGE" \
    bash -c "cd /data && tar xzf '/in/$(basename "$largest")' --no-same-owner && chown -R 1000:1000 /data"
  then
    # The layout OpenClaw actually boots from: an agents/ tree with a workspace.
    # Match the dir exactly (not a truncated listing that head could cut off).
    has_agents=$(docker run --rm -v "$DRILL_VOL:/data:ro" "$IMAGE" \
      bash -c "find /data -maxdepth 1 -type d -name agents | head -1")
    files=$(docker run --rm -v "$DRILL_VOL:/data:ro" "$IMAGE" bash -c "find /data -type f | wc -l")
    if [ -n "$has_agents" ] && [ "$files" -gt 0 ]; then
      echo "  ✓ $(basename "$largest") restores: $files files, agents/ tree present"
    else
      echo "  ✗ $(basename "$largest") restored but the OpenClaw layout is missing" >&2
      fail=1
    fi
  else
    echo "  ✗ $(basename "$largest") failed to extract into a fresh volume" >&2
    fail=1
  fi
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "✅ Restore drill passed — this backup would bring the system back."
else
  echo "❌ Restore drill FAILED — fix this before you need the backup." >&2
  exit 1
fi
