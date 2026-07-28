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

mkdir -p "$DEST"

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
