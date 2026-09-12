#!/usr/bin/env bash
# Deploy a tagged release into the PRODUCTION checkout and restart the service.
#
#   scripts/deploy-release.sh v0.141.0           # deploy that tag
#   scripts/deploy-release.sh v0.140.1           # …or roll back to an earlier one
#
# The production checkout is separate from wherever you develop (see
# docs/releasing.md). Override the defaults with env vars:
#   HATCHABOT_PROD_DIR   (default ~/hatchabot-prod)
#   HATCHABOT_SERVICE    (default hatchabot — a systemd --user unit)
#   HATCHABOT_HEALTH_URL (default http://127.0.0.1:${PORT:-8080}/)
set -euo pipefail
TAG="${1:?usage: deploy-release.sh vX.Y.Z}"
PROD="${HATCHABOT_PROD_DIR:-$HOME/hatchabot-prod}"
SVC="${HATCHABOT_SERVICE:-hatchabot}"
[ -d "$PROD/.git" ] || { echo "No production checkout at $PROD — clone the repo there first (docs/releasing.md)."; exit 1; }
cd "$PROD"
git fetch --tags --quiet origin
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "Tag $TAG not found on origin."; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "$PROD has local changes — production must never be edited by hand. Refusing."; exit 1; }
CUR="$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)"
echo "Deploying $TAG to $PROD (currently $CUR)…"
git checkout --quiet "$TAG"
npm ci --silent
systemctl --user restart "$SVC"
WANT="$(node -e 'console.log(require("./package.json").version)')"
URL="${HATCHABOT_HEALTH_URL:-http://127.0.0.1:${PORT:-8080}/}"
for i in $(seq 1 30); do
  GOT="$(curl -s "$URL" 2>/dev/null | grep -oE 'HATCHABOT_VERSION="[^"]+"' | head -1 | cut -d'"' -f2 || true)"
  [ "$GOT" = "$WANT" ] && { echo "Serving $GOT."; exit 0; }
  sleep 2
done
echo "Service restarted but is not serving $WANT yet — check: journalctl --user -u $SVC -n 50"; exit 1
