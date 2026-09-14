#!/usr/bin/env bash
# Deploy a tagged release into the PRODUCTION checkout and restart the service.
#
#   scripts/deploy-release.sh v1.2.0             # deploy that tag
#   scripts/deploy-release.sh v1.1.0             # …or roll back to an earlier one
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
rollback() { echo "Rolling back to $CUR…"; git checkout --quiet "$CUR" && npm ci --silent && systemctl --user restart "$SVC"; }
git checkout --quiet "$TAG"
# A failed install must not leave prod checked out at a tag it can't run.
npm ci --silent || { rollback; exit 1; }
systemctl --user restart "$SVC" || { rollback; exit 1; }
WANT="$(node -e 'console.log(require("./package.json").version)')"
# Health URL from the production .env, not the caller's shell: PORT and native TLS.
envval() { sed -n "s/^$1=//p" .env 2>/dev/null | head -1 | sed -e 's/[[:space:]]*#.*$//' -e "s/^['\"]//" -e "s/['\"]$//"; }
P="$(envval PORT)"; P="${P:-8080}"
SCHEME=http; [ -n "$(envval HATCHABOT_TLS_CERT)" ] && SCHEME=https
URL="${HATCHABOT_HEALTH_URL:-$SCHEME://127.0.0.1:$P/}"
for i in $(seq 1 45); do
  GOT="$(curl -sk "$URL" 2>/dev/null | grep -oE 'HATCHABOT_VERSION="[^"]+"' | head -1 | cut -d'"' -f2 || true)"
  [ "$GOT" = "$WANT" ] && { echo "Serving $GOT."; exit 0; }
  sleep 2
done
echo "Service restarted but is not serving $WANT — check: journalctl --user -u $SVC -n 50"; rollback; exit 1
