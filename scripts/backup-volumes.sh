#!/usr/bin/env bash
# Nightly agent backups: one tarball per agentclaw volume, 14 days retention.
#
# Backs up ALL agentclaw volumes found in docker, not just what the registry
# knows — a backup tool should trust the disk, not the database.
#
#   ./scripts/backup-volumes.sh            # manual run
#   AGENTCLAW_BACKUP_DIR=/mnt/nas/claw …   # override destination
#
# Restore (agent must be stopped):
#   docker run --rm -v <volume>:/data -v <backup-dir>:/in:ro \
#     agentclaw-runtime:latest bash -c 'cd /data && tar xzf /in/<volume>.tgz'
set -euo pipefail

BASE="${AGENTCLAW_BACKUP_DIR:-$HOME/agentclaw-backups}"
DEST="$BASE/$(date +%F)"
IMAGE="${AGENTCLAW_IMAGE:-agentclaw-runtime:latest}"
KEEP_DAYS="${AGENTCLAW_BACKUP_KEEP_DAYS:-14}"

# Tarballs contain openclaw.json — bot tokens and gateway tokens in the clear.
mkdir -p "$BASE" && chmod 700 "$BASE"
mkdir -m 700 -p "$DEST"
umask 077

# The control plane's own database first: it holds the encrypted bot tokens,
# the agent registry, memberships and snapshots. Volumes survive without it,
# but AgentClaw would forget every agent it ever made. Use SQLite's online
# backup API — the DB is in WAL mode, so `cp` on a running server can tear.
DB_PATH="${AGENTCLAW_DB:-data/agentclaw.sqlite}"
if [ -f "$DB_PATH" ]; then
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
    grep '^AGENTCLAW_SECRET_KEY=' .env > "$DEST/secret-key.env" 2>/dev/null || true
    chmod 600 "$DEST/secret-key.env"
  fi
fi

count=0
for vol in $(docker volume ls -q | grep -E '^agentclaw-' || true); do
  # Read-only mount; tar from inside a throwaway container so we never need
  # root on the host to reach /var/lib/docker.
  docker run --rm -v "$vol:/data:ro" -v "$DEST:/out" "$IMAGE" \
    bash -c "tar czf '/out/$vol.tgz' -C /data ."
  echo "  ✓ $vol → $DEST/$vol.tgz"
  count=$((count + 1))
done

# Prune old snapshot directories.
find "$BASE" -mindepth 1 -maxdepth 1 -type d -mtime "+$KEEP_DAYS" -exec rm -rf {} +

echo "Backed up $count volume(s) to $DEST (keeping $KEEP_DAYS days)"
