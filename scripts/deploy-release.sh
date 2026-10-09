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
#
# Exit codes (follow-latest.sh reads them): 0 serving the tag; 1 it did not
# come up and the previous release is back — the only code that means "do
# not retry this tag"; 2 refused (local changes); 3 did not complete (the
# install step, anything unplanned) with the previous release back; 4 another
# deploy or upgrade is running.
set -euo pipefail
TAG="${1:?usage: deploy-release.sh vX.Y.Z}"
PROD="${HATCHABOT_PROD_DIR:-$HOME/hatchabot-prod}"
SVC="${HATCHABOT_SERVICE:-hatchabot}"
[ -d "$PROD/.git" ] || { echo "No production checkout at $PROD — clone the repo there first (docs/releasing.md)."; exit 2; }
cd "$PROD"
git fetch --tags --force --quiet origin
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "Tag $TAG not found on origin."; exit 2; }
# Refusing is right; refusing without saying WHAT is not. An untracked stray —
# a note saved into the wrong directory — reads identically to a hand-edit here,
# and the operator can only act if the message names it.
if [ -n "$(git status --porcelain)" ]; then
  echo "$PROD has local changes — production must never be edited by hand. Refusing."
  echo
  git status --porcelain | sed 's/^/    /'
  echo
  echo "  ?? = an untracked file that does not belong to the release. If it is"
  echo "       something of yours, move it out:  mv $PROD/<file> ~/"
  echo "  Any other marker = a tracked file was edited in place. Restore it with"
  echo "       git -C $PROD checkout -- <file>   (your .env and data/ are untouched)"
  exit 2
fi
# The SAME lock upgrade.sh takes (a directory: mkdir is atomic everywhere,
# and macOS has no flock). A flock here and a mkdir there did not exclude each
# other, so `hbt upgrade` and the follow-latest timer could race one checkout's
# node_modules.prev (night review, 2026-09-28). Keyed on $PWD, as upgrade.sh
# is. A lock older than an hour is a crash's leftover. In this user's state
# folder, not /tmp, where anyone on a shared host could make it first and stop
# every deploy (review, 2026-10-09).
LOCKS="${XDG_STATE_HOME:-$HOME/.local/state}/hatchabot"; mkdir -p "$LOCKS"
LOCK="$LOCKS/upgrade-$(printf %s "$PWD" | cksum | cut -d' ' -f1).lock.d"
if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null || true; fi
mkdir "$LOCK" 2>/dev/null || { echo "Another deploy or upgrade of $PROD is running (lock $LOCK)."; exit 4; }
CUR="$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)"
# Whatever ends the script ends here. Something it did not plan for (set -e
# after node_modules was moved aside) left a half-changed checkout and exit 1,
# which follow-latest.sh reads as "this tag does not start" and never retries
# (review, 2026-10-09). Now the previous release is put back, and only an
# explicit rollback says 1.
ROLLED_BACK=0; CHANGING=0; RESTARTED=0
finish() {
  local rc=$?
  set +e
  if [ "$rc" != 0 ] && [ "$CHANGING" = 1 ]; then CHANGING=0; rc=3; echo "The deploy stopped part-way — putting $CUR back."; rollback; fi
  rmdir "$LOCK" 2>/dev/null
  case "$rc" in 0|2|3|4) ;; 1) [ "$ROLLED_BACK" = 1 ] || rc=3 ;; *) rc=3 ;; esac
  exit "$rc"
}
trap finish EXIT
echo "Deploying $TAG to $PROD (currently $CUR)…"
# `npm ci` wipes node_modules first: keep the working one aside until the new
# one is in, or an npm outage leaves prod with no dependencies (exit 3 = that;
# the old release is back untouched).
restore_deps() { rm -rf node_modules; [ -d node_modules.prev ] && mv node_modules.prev node_modules; return 0; }
# The service is restarted only when it was restarted onto the new release:
# an install that failed left the old one serving, and restarting it anyway
# restarted production every ten minutes while a tag that cannot install kept
# failing (review, 2026-10-09).
rollback() {
  echo "Rolling back to ${CUR}…"
  git checkout --quiet "$CUR" && restore_deps || return 1
  if [ "$RESTARTED" = 1 ]; then systemctl --user restart "$SVC"; fi
}
# The install upgrade.sh does: ensure-deps installs, compiles the database
# driver where its prebuilt one does not load (sqlite-driver.sh) and writes
# the stamp restart.sh checks — a bare `npm ci` did neither (review,
# 2026-10-09). A tag from before ensure-deps.sh gets npm ci.
install_deps() { if [ -x scripts/ensure-deps.sh ]; then ./scripts/ensure-deps.sh --quiet; else npm ci --silent; fi; }
INSTALL="${HATCHABOT_INSTALL_CMD:-install_deps}"   # overridable for tests only
CHANGING=1
rm -rf node_modules.prev; [ -d node_modules ] && mv node_modules node_modules.prev
git checkout --quiet "$TAG"
# A failed install must not leave prod checked out at a tag it can't run.
$INSTALL || { CHANGING=0; rollback || true; exit 3; }
# node_modules.prev stays until the new release is SERVING: removed here, a
# failed health check's rollback found nothing to restore and left prod with
# no dependencies at all (night review, 2026-09-28).
RESTARTED=1
systemctl --user restart "$SVC" || { CHANGING=0; ROLLED_BACK=1; rollback || true; exit 1; }
WANT="$(node -e 'console.log(require("./package.json").version)')"
# Health URL from the production .env, not the caller's shell: PORT and native TLS.
# (No .env is "not set": under pipefail sed's exit 2 for a missing file ended the deploy.)
envval() { { sed -n "s/^$1=//p" .env 2>/dev/null || true; } | sed -n 1p | sed -e 's/[[:space:]]*#.*$//' -e "s/^['\"]//" -e "s/['\"]$//"; }
P="$(envval PORT)"; P="${P:-8080}"
SCHEME=http; [ -n "$(envval HATCHABOT_TLS_CERT)" ] && SCHEME=https
URL="${HATCHABOT_HEALTH_URL:-$SCHEME://127.0.0.1:$P/}"
for i in $(seq 1 45); do
  GOT="$(curl -sk "$URL" 2>/dev/null | grep -oE 'HATCHABOT_VERSION="[^"]+"' | sed -n 1p | cut -d'"' -f2 || true)"
  [ "$GOT" = "$WANT" ] && { CHANGING=0; rm -rf node_modules.prev; echo "Serving $GOT."; exit 0; }
  sleep 2
done
echo "Service restarted but is not serving $WANT — check: journalctl --user -u $SVC -n 50"
CHANGING=0; ROLLED_BACK=1; rollback || true; exit 1
