#!/usr/bin/env bash
# Nightly agent backups: one tarball per hatchabot volume, 14 days retention.
#
# Backs up the hatchabot volumes found in docker. A volume no agent in the
# registry uses (a leftover from before a rename) is reported, not archived
# every night; when the registry can't be read, every volume is taken — a
# backup tool trusts the disk before it trusts a database it could not read.
#
# Each set ends with backup-status.json (complete or not, how many volumes,
# which failed or were left out), so the app can tell a finished set from a
# partial one: the dated directory exists long before the last volume is in.
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
cd "$(dirname "$0")/.."

# The server namespaces its volumes under HATCHABOT_PREFIX — back up whatever
# namespace this installation actually uses, not a hardcoded one.
# Pre-rename .env files: alias AGENTCLAW_* → HATCHABOT_* (existing HATCHABOT_* wins).
for v in $(compgen -A variable AGENTCLAW_ 2>/dev/null); do n="HATCHABOT_${v#AGENTCLAW_}"; [ -n "${!n+x}" ] || export "$n=${!v}"; done
PREFIX="${HATCHABOT_PREFIX:-hatchabot}"
BASE="${HATCHABOT_BACKUP_DIR:-$HOME/hatchabot-backups}"
[ -d "$BASE" ] || [ -n "${HATCHABOT_BACKUP_DIR:-}" ] || { [ -d "$HOME/agentclaw-backups" ] && BASE="$HOME/agentclaw-backups"; }   # pre-rename hosts
DEST="$BASE/$(date +%F)"
IMAGE="${HATCHABOT_IMAGE:-hatchabot-runtime:latest}"
KEEP_DAYS="${HATCHABOT_BACKUP_KEEP_DAYS:-14}"

# Tarballs contain openclaw.json — bot tokens and gateway tokens in the clear.
mkdir -p "$BASE" && chmod 700 "$BASE"
mkdir -m 700 -p "$DEST"
# mkdir -m only applies on creation — tighten a pre-existing directory too.
chmod 700 "$DEST"
umask 077

# The set's own record. "running" until the end; whatever way the script ends
# (a refusal, a failed volume, set -e, Ctrl-C) the EXIT trap writes the verdict.
# Only a SIGKILL leaves "running", which the app reads as unfinished once it
# is hours old (review, 2026-09-29).
STATUS="$DEST/backup-status.json"
count=0
failed=0
failed_list=""
orphan_list=""
started="$(date -u +%FT%TZ)"
json_list() { local out="" x; for x in $1; do out="$out${out:+,}\"$x\""; done; printf '[%s]' "$out"; }
write_status() {
  printf '{"state":"%s","startedAt":"%s","finishedAt":"%s","volumes":%d,"failed":%d,"failedVolumes":%s,"orphans":%s}\n' \
    "$1" "$started" "$(date -u +%FT%TZ)" "$count" "$failed" "$(json_list "$failed_list")" "$(json_list "$orphan_list")" \
    > "$STATUS.tmp" && mv -f "$STATUS.tmp" "$STATUS"
}
write_status running
finish() { local rc=$?; if [ "$rc" -eq 0 ]; then write_status complete; else write_status incomplete; fi; exit "$rc"; }
trap finish EXIT

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
if [ -f .env ]; then
  if grep -E '^(HATCHABOT|AGENTCLAW)_SECRET_KEY=' .env | sed 's/^AGENTCLAW_/HATCHABOT_/' > "$DEST/secret-key.env" && [ -s "$DEST/secret-key.env" ]; then
    chmod 600 "$DEST/secret-key.env"
  else
    # An empty secret-key.env would read as "key backed up" at restore time.
    rm -f "$DEST/secret-key.env"
    echo "  ⚠ .env has no HATCHABOT_SECRET_KEY — this backup's secrets cannot be decrypted without the key!" >&2
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
vols="$(printf '%s\n' "$all_vols" | grep -E "^(${PREFIX}|agentclaw)-" || true)"
if [ -z "$vols" ]; then
  # No matching volumes — distinguish a genuinely fresh box (no agents yet,
  # fine) from "agents exist but their volumes are missing or under a
  # different HATCHABOT_PREFIX" (dangerous — must not prune good backups).
  # The DB we just copied is the source of truth for how many agents exist.
  agent_count="$(node -e 'const D=require("better-sqlite3");const db=new D(process.argv[1],{readonly:true});process.stdout.write(String(db.prepare("SELECT COUNT(*) c FROM agents WHERE state != \x27DELETED\x27").get().c))' "$DEST/hatchabot.sqlite" 2>/dev/null || echo unknown)"
  if [ "$agent_count" = "0" ]; then
    echo "No agents yet — database backed up, no volumes to capture."
    exit 0
  fi
  echo "✗ $agent_count agent(s) in the DB but no ${PREFIX}-* volumes found (HATCHABOT_PREFIX mismatch?) — refusing to prune." >&2
  exit 1
fi

# The volumes the registry's agents use (`<runtime ref name>-vol`, the same
# rule agentArchiveName follows). Empty when the DB copy can't be read: then
# every volume is taken, as before.
known="$(node -e 'const D=require("better-sqlite3");const db=new D(process.argv[1],{readonly:true});for(const r of db.prepare("SELECT runtime_ref FROM agents WHERE state != \x27DELETED\x27 AND runtime_ref IS NOT NULL").all())console.log(String(r.runtime_ref).replace(/^\w+:\/\//,"")+"-vol")' "$DEST/hatchabot.sqlite" 2>/dev/null || true)"

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
    bash -c "umask 077 && tar czf '/out/$vol.tgz' $TAR_EXCLUDES -C /data . ; rc=\$?; chown $(id -u):$(id -g) '/out/$vol.tgz' 2>/dev/null; exit \$rc" || rc=$?
  if [ "$rc" -gt 1 ] || [ ! -f "$DEST/$vol.tgz" ]; then
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
