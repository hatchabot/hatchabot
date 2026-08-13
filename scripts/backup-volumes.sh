#!/usr/bin/env bash
# Nightly agent backups: one tarball per agentclaw volume, 14 days retention.
#
# Backs up ALL agentclaw volumes found in docker, not just what the registry
# knows — a backup tool should trust the disk, not the database.
#
#   ./scripts/backup-volumes.sh            # manual run
#   AGENTCLAW_BACKUP_DIR=/mnt/nas/claw …   # override destination
#
# Restore (agent must be stopped; --user root because a FRESH volume is
# root-owned and the image's own user can't mkdir in it — the new-machine
# case. Verified by scripts/restore-drill.sh, which caught exactly this):
#   docker run --rm --user root -v <volume>:/data -v <backup-dir>:/in:ro \
#     agentclaw-runtime:latest \
#     bash -c 'cd /data && tar xzf /in/<volume>.tgz --no-same-owner && chown -R 1000:1000 /data'
set -euo pipefail
cd "$(dirname "$0")/.."

# The server namespaces its volumes under AGENTCLAW_PREFIX — back up whatever
# namespace this installation actually uses, not a hardcoded one.
PREFIX="${AGENTCLAW_PREFIX:-agentclaw}"
BASE="${AGENTCLAW_BACKUP_DIR:-$HOME/agentclaw-backups}"
DEST="$BASE/$(date +%F)"
IMAGE="${AGENTCLAW_IMAGE:-agentclaw-runtime:latest}"
KEEP_DAYS="${AGENTCLAW_BACKUP_KEEP_DAYS:-14}"

# Tarballs contain openclaw.json — bot tokens and gateway tokens in the clear.
mkdir -p "$BASE" && chmod 700 "$BASE"
mkdir -m 700 -p "$DEST"
# mkdir -m only applies on creation — tighten a pre-existing directory too.
chmod 700 "$DEST"
umask 077

# The control plane's own database first: it holds the encrypted bot tokens,
# the agent registry, memberships and snapshots. Volumes survive without it,
# but AgentClaw would forget every agent it ever made. Use SQLite's online
# backup API — the DB is in WAL mode, so `cp` on a running server can tear.
DB_PATH="${AGENTCLAW_DB:-data/agentclaw.sqlite}"
if [ ! -f "$DB_PATH" ]; then
  echo "✗ No database at $DB_PATH — a backup without the registry is not a backup." >&2
  exit 1
fi
node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.argv[1], { readonly: true });
  db.backup(process.argv[2]).then(() => { db.close(); })
    .catch((e) => { console.error(e); process.exit(1); });
' "$DB_PATH" "$DEST/agentclaw.sqlite"
chmod 600 "$DEST/agentclaw.sqlite"
echo "  ✓ control plane database → $DEST/agentclaw.sqlite"
# Without the key the backup's secrets are undecryptable, so keep a copy
# beside it. Both are only as safe as this directory (0700).
if [ -f .env ]; then
  if grep '^AGENTCLAW_SECRET_KEY=' .env > "$DEST/secret-key.env"; then
    chmod 600 "$DEST/secret-key.env"
  else
    # An empty secret-key.env would read as "key backed up" at restore time.
    rm -f "$DEST/secret-key.env"
    echo "  ⚠ .env has no AGENTCLAW_SECRET_KEY — this backup's secrets cannot be decrypted without the key!" >&2
  fi
fi

# The runtime image normally provides tar; on a host that hasn't built it yet
# any stock image will do — tar is all we need here.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "  ⚠ $IMAGE not found — falling back to debian:stable-slim for tar." >&2
  IMAGE="debian:stable-slim"
fi

# List the volumes FIRST, and distinguish "daemon down" from "no volumes".
# `docker volume ls` failing (daemon down/permission) must not masquerade as
# an empty list — that produced a 0-volume "success" that then pruned the last
# good backups. Only a clean exit with genuinely no matches is "nothing here".
if ! all_vols="$(docker volume ls -q)"; then
  echo "✗ Could not list docker volumes (daemon down or no permission) — backup aborted, nothing pruned." >&2
  exit 1
fi
vols="$(printf '%s\n' "$all_vols" | grep -E "^${PREFIX}-" || true)"
if [ -z "$vols" ]; then
  echo "✗ No ${PREFIX}-* volumes found. The DB was backed up, but no agent state was — refusing to prune." >&2
  exit 1
fi

count=0
failed=0
while IFS= read -r vol; do
  [ -n "$vol" ] || continue
  # Read-only mount; tar from inside a throwaway container so we never need
  # root on the host to reach /var/lib/docker. Run as root so it can read
  # uid-1000 volume files on ANY host (macOS uid is 501), then chown the
  # output to the invoking user and umask 077 so the tarball is host-owned
  # and never world-readable, even on the failure path.
  # GNU tar exits 1 for "file changed as we read it" — expected on a live
  # volume, and the archive is still usable. Only >1 is a hard failure, and
  # one bad volume must not abort the rest of the run.
  rc=0
  docker run --rm --user root -v "$vol:/data:ro" -v "$DEST:/out" "$IMAGE" \
    bash -c "umask 077 && tar czf '/out/$vol.tgz' -C /data . ; rc=\$?; chown $(id -u):$(id -g) '/out/$vol.tgz' 2>/dev/null; exit \$rc" || rc=$?
  if [ "$rc" -gt 1 ] || [ ! -f "$DEST/$vol.tgz" ]; then
    echo "  ✗ $vol failed (exit $rc)" >&2
    failed=$((failed + 1))
    continue
  fi
  chmod 600 "$DEST/$vol.tgz"
  echo "  ✓ $vol → $DEST/$vol.tgz"
  count=$((count + 1))
done <<EOF
$vols
EOF

# Prune ONLY after confirming this backup is complete — a failing/partial run
# must never delete the last good snapshots. Restricted to our own date-named
# directories, since the destination may be a shared path (e.g. a NAS).
if [ "$failed" -gt 0 ] || [ "$count" -eq 0 ]; then
  echo "✗ $failed volume(s) failed, $count succeeded — incomplete backup, nothing pruned." >&2
  exit 1
fi
find "$BASE" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??' -mtime "+$KEEP_DAYS" -exec rm -rf {} +
echo "Backed up $count volume(s) to $DEST (keeping $KEEP_DAYS days)"
