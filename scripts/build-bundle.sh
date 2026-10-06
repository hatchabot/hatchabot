#!/usr/bin/env bash
# Build the prebuilt release bundle for ONE platform (docs/install-bundle.md):
#
#   scripts/build-bundle.sh <tag> <platform> [outdir]     e.g. v2.132.0 linux-arm64 dist-bundles
#
# Run it ON the platform it is for (the release workflow's matrix does: an old
# Ubuntu for Linux, so the database driver it compiles loads on any glibc from
# 2.35 up; macOS 14 for Apple silicon), with Node 22 on PATH and a C++
# toolchain. The bundle is a plain archive — not an image — holding:
#   hatchabot/            the release's files at <tag> (git archive)
#   hatchabot/node_modules  production dependencies, the driver compiled here,
#                         with the lock stamp ensure-deps.sh reads (so nothing
#                         is ever installed on the user's machine)
#   hatchabot/.node/bin/node  this Node, private to Hatchabot
#   hatchabot/BUNDLE.json version, platform, Node version, when it was built
# and a .sha256 beside it. It checks itself before it is written: the private
# Node must load the driver and open a database.
set -euo pipefail
TAG="${1:?usage: build-bundle.sh <tag> <platform> [outdir]}"
PLATFORM="${2:?usage: build-bundle.sh <tag> <platform> [outdir]}"
OUT="$(mkdir -p "${3:-dist-bundles}" && cd "${3:-dist-bundles}" && pwd)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
case "$PLATFORM" in linux-x64|linux-arm64|darwin-arm64) ;; *) echo "unknown platform $PLATFORM" >&2; exit 2 ;; esac
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node 22+ is needed to build the bundle" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/hatchabot"
mkdir -p "$STAGE"
# HATCHABOT_BUNDLE_REF: build from another commit under this name (a test bundle from a branch).
git -C "$ROOT" archive "${HATCHABOT_BUNDLE_REF:-$TAG}" | tar -x -C "$STAGE"
cd "$STAGE"

echo "== dependencies (production only; the driver compiles here)"
npm ci --omit=dev --no-audit --no-fund
# Compiled here, on the old base, so it loads on any glibc from this one up —
# the driver's own Linux binaries need 2.38 (sqlite-driver.sh).
HATCHABOT_APP_DIR="$STAGE" "$ROOT/scripts/sqlite-driver.sh" --compile
# The stamp ensure-deps.sh compares: the bundle's dependencies ARE this lockfile's.
cksum package-lock.json | cut -d' ' -f1 > node_modules/.hatchabot-lock-stamp

echo "== private Node"
mkdir -p .node/bin
cp "$(command -v node)" .node/bin/node
chmod 755 .node/bin/node

echo "== self-check"
./.node/bin/node -e '
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (x INTEGER)"); db.prepare("INSERT INTO t VALUES (?)").run(42);
  if (db.prepare("SELECT x FROM t").get().x !== 42) process.exit(1);
  console.log("driver ok on node " + process.version);
'
./.node/bin/node ./node_modules/tsx/dist/cli.mjs --version >/dev/null

VERSION="${TAG#v}"
printf '{"version":"%s","tag":"%s","platform":"%s","node":"%s","builtAt":"%s"}\n' \
  "$VERSION" "$TAG" "$PLATFORM" "$(./.node/bin/node --version)" "$(date -u +%FT%TZ)" > BUNDLE.json

# The bundle's own top-level files: an upgrade swaps exactly these, so .env,
# data/ and backups beside them are never touched (scripts/upgrade.sh).
ls -A > .bundle-files
echo .bundle-files >> .bundle-files
sort -u -o .bundle-files .bundle-files

NAME="hatchabot-$TAG-$PLATFORM.tar.gz"
tar -C "$WORK" -czf "$OUT/$NAME" hatchabot
( cd "$OUT" && { command -v sha256sum >/dev/null && sha256sum "$NAME" || shasum -a 256 "$NAME"; } > "$NAME.sha256" )
echo "== $OUT/$NAME ($(du -h "$OUT/$NAME" | cut -f1))"
