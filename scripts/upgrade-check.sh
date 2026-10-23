#!/usr/bin/env bash
# Can a database created by an OLDER Hatchabot be opened by this one?
#
#   ./scripts/upgrade-check.sh [tag ...]     (default: a spread of past releases)
#   ./scripts/upgrade-check.sh --list        (the default tags, one a line; checks nothing)
#
# `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
# a column added to one after it shipped reaches a fresh database and never an
# upgraded one — where every read of it then throws. v2.14.0 shipped exactly
# that bug (pairing_window.expect) and took the Telegram approve flow down on a
# live install while every unit test stayed green, because every unit test
# starts from a fresh :memory: database.
#
# So: build a database with the OLD code, open it with the NEW code, and diff
# the schema. Real upgrade, not a simulation of one.
set -euo pipefail
[ -x "$(dirname "$0")/../.node/bin/node" ] && PATH="$(cd "$(dirname "$0")/.." && pwd)/.node/bin:$PATH" && export PATH  # a bundle install's own Node (install.sh)
cd "$(dirname "$0")/.."
REPO="$(pwd)"
TMP="$(mktemp -d)"
trap 'git worktree remove --force "$TMP/old" 2>/dev/null || true; rm -rf "$TMP"' EXIT

LIST=0; [ "${1:-}" != --list ] || { LIST=1; shift; }
TAGS=("$@")
if [ ${#TAGS[@]} -eq 0 ]; then
  # The oldest release we promise to upgrade from, the last major, and the
  # newest release before this checkout — the one installs run now. Most
  # breaks are one of those three hops. That is the newest tag unless it
  # names this very commit (a checkout of a release): a pull request or a
  # version commit is past the newest tag, and taking the one before it
  # skipped the release users run (audit, 2026-10-20).
  mapfile -t ALL < <(git tag --sort=-creatordate | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true)
  HERE="$(git tag --points-at HEAD)"
  PREV=""
  for t in ${ALL[@]+"${ALL[@]}"}; do
    printf '%s\n' "$HERE" | grep -qxF "$t" || { PREV="$t"; break; }
  done
  TAGS=()
  for t in "v1.0.0" "v2.0.0" "$PREV"; do
    [ -n "$t" ] && git rev-parse -q --verify "refs/tags/$t" >/dev/null || continue
    printf '%s\n' ${TAGS[@]+"${TAGS[@]}"} | grep -qxF "$t" || TAGS+=("$t")
  done
fi
if [ "$LIST" = 1 ]; then printf '%s\n' ${TAGS[@]+"${TAGS[@]}"}; exit 0; fi
[ ${#TAGS[@]} -gt 0 ] || { echo "No tags to check against — nothing to do."; exit 0; }

fail=0
for tag in ${TAGS[@]+"${TAGS[@]}"}; do
  echo "== upgrading from $tag"
  rm -rf "$TMP/old"
  git worktree prune            # a removed directory stays registered otherwise
  git worktree add --detach --force --quiet "$TMP/old" "$tag"
  # The old tree's own source, the current tree's node_modules (same ABI, and
  # the point of the test is the SCHEMA, not the dependencies).
  ln -s "$REPO/node_modules" "$TMP/old/node_modules"
  db="$TMP/$tag.sqlite"
  cat > "$TMP/old/make-db.ts" <<'TS'
import Database from 'better-sqlite3';
import { Store } from './src/store/store.js';
new Store(new Database(process.argv[2]!));   // constructing it writes the schema
console.log('made', process.argv[2]);
TS
  ( cd "$TMP/old" && npx tsx make-db.ts "$db" >/dev/null ) \
    || { echo "   could not build a database at $tag — skipping"; continue; }
  # --migrate: open it the way the server does, so the ALTERs get their chance.
  if npx tsx scripts/schema-drift.ts "$db" --migrate; then
    echo "   ok"
  else
    echo "   ^ an upgrade from $tag would break: add an ALTER TABLE in store.ts"
    fail=1
  fi
done
exit "$fail"
