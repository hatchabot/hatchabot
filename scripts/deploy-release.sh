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
#   HATCHABOT_HEALTH_URL (default: the PORT and HATCHABOT_BIND in its .env, or http://127.0.0.1:8080/)
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
# Whatever ends the script ends here. Something it did not plan for (set -e
# after node_modules was moved aside) left a half-changed checkout and exit 1,
# which follow-latest.sh reads as "this tag does not start" and never retries
# (review, 2026-10-09). Now the previous release is put back, and only an
# explicit rollback says 1. Set before the first step that can fail: a fetch
# that met another fetch's ref lock said 1 before anything was changed, and
# the tag was set aside for good (audit #032).
ROLLED_BACK=0; CHANGING=0; RESTARTED=0; ASIDE=0; SERVING=0; LOCK=""
finish() {
  local rc=$?
  set +e
  if [ "$rc" != 0 ] && [ "$CHANGING" = 1 ]; then CHANGING=0; rc=3; echo "The deploy stopped part-way — putting $CUR back."; rollback; fi
  # Stopped once the new release was serving (removing the old dependencies):
  # it is deployed, not a failure to try again (HB-0266). A node_modules.prev
  # left half removed goes with the next deploy.
  if [ "$SERVING" = 1 ]; then rm -f "$FROM_FILE"; rc=0; fi
  [ -z "$LOCK" ] || [ "$(cat "$LOCK/owner" 2>/dev/null)" != "$ME" ] || rm -rf "$LOCK"
  case "$rc" in 0|2|3|4) ;; 1) [ "$ROLLED_BACK" = 1 ] || rc=3 ;; *) rc=3 ;; esac
  exit "$rc"
}
trap finish EXIT
# Stopped by a signal (`systemctl stop` of the timer's unit, a Ctrl-C, a closed
# terminal), bash ended without running finish: a deploy cut off in the
# install left prod on the new tag with half its dependencies and the old ones
# in node_modules.prev (HB-0266). Ended through exit, finish puts the old one
# back, as upgrade.sh does (HB-0043).
trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP
# The SAME lock upgrade.sh takes (a directory: mkdir is atomic everywhere,
# and macOS has no flock). A flock here and a mkdir there did not exclude each
# other, so `hbt upgrade` and the follow-latest timer could race one checkout's
# node_modules.prev (night review, 2026-09-28). Keyed on $PWD, as upgrade.sh
# is, and taken the same way: its holder written in it, and only a holder
# that is gone (or, with none written, an hour) makes it a leftover, cleared
# under a second lock (#226). In this user's state folder, not /tmp, where
# anyone on a shared host could make it first and stop every deploy (review,
# 2026-10-09).
LOCKS="${XDG_STATE_HOME:-$HOME/.local/state}/hatchabot"; mkdir -p "$LOCKS"
LOCK_PATH="$LOCKS/upgrade-$(printf %s "$PWD" | cksum | cut -d' ' -f1).lock.d"
proc_start() { LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//'; }
ME="$$"; MY_START="$(proc_start $$)"; [ -z "$MY_START" ] || ME="$$ $MY_START"
lock_left_over() {
  local owner pid
  owner="$(cat "$LOCK_PATH/owner" 2>/dev/null)" || owner=""
  if [ -z "$owner" ]; then [ -n "$(find "$LOCK_PATH" -maxdepth 0 -mmin +60 2>/dev/null)" ]; return; fi
  pid="${owner%% *}"
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  if [ "$owner" = "$pid" ]; then ! kill -0 "$pid" 2>/dev/null; else [ "$owner" != "$pid $(proc_start "$pid")" ]; fi
}
take_lock() {
  mkdir "$LOCK_PATH" 2>/dev/null || return 1
  LOCK="$LOCK_PATH"
  printf '%s\n' "$ME" > "$LOCK_PATH/owner.$$" && mv -f "$LOCK_PATH/owner.$$" "$LOCK_PATH/owner"
}
if ! take_lock; then
  [ -z "$(find "$LOCK_PATH.clearing" -maxdepth 0 -mmin +10 2>/dev/null)" ] || rmdir "$LOCK_PATH.clearing" 2>/dev/null || true
  if [ -d "$LOCK_PATH" ] && lock_left_over && mkdir "$LOCK_PATH.clearing" 2>/dev/null; then
    if lock_left_over; then rm -rf "$LOCK_PATH"; fi
    rmdir "$LOCK_PATH.clearing" 2>/dev/null || true
  fi
  take_lock || { echo "Another deploy or upgrade of $PROD is running (lock $LOCK_PATH)."; exit 4; }
fi
# A deploy in progress, beside the lock, in the record upgrade.sh keeps
# (its FROM_FILE, the same file for the same checkout): `from <release>`, then
# `restarted` once the service was restarted onto the new one. Left behind,
# the run was killed part-way (SIGKILL, a power cut): the checkout may be on
# the new tag with half its dependencies, and the old ones in
# node_modules.prev. Put the old release back first, then deploy as usual
# (HB-0266).
FROM_FILE="${LOCK_PATH%.lock.d}.from"
# Every checkout under the record writes its holder there first, by the process
# that becomes git (pid and start time, as the lock's holder): a kill in the
# checkout leaves .git/index.lock, and every later deploy failed on it.
# Not with a lock already there: this checkout cannot take it and makes no lock
# of its own, and a line written now left the record newer than the lock of the
# git that was killed alone, so that lock never read as this run's (below).
checkout_recorded() {
  sh -c '[ -e .git/index.lock ] || printf "git %s %s\n" "$$" "$(LC_ALL=C ps -o lstart= -p $$ 2>/dev/null | tr -s " " | sed "s/^ //;s/ $//")" >> "$1"; shift; exec git checkout "$@"' _ "$FROM_FILE" "$@"
}
# A git running in this checkout, whoever started it: its pid, or "unknown" when
# this machine has no way to tell. A commit waiting in its editor holds the lock
# for as long as the person takes, however old the lock looks.
git_running_here() {
  local here p comm cwd line pid=""
  here="$(pwd -P)"
  if [ -d "/proc/$$" ]; then
    # Read with the builtin, not $(cat): one cat per process on the machine
    # took 1.7 s with 900 running, and longer the busier it was (HB-0505).
    for p in /proc/[0-9]*; do
      { read -r comm < "$p/comm"; } 2>/dev/null || continue
      case "$comm" in git|git-*) ;; *) continue ;; esac
      cwd="$(readlink "$p/cwd" 2>/dev/null)" || continue
      case "$cwd/" in "$here/"*) echo "${p#/proc/}"; return 0 ;; esac
    done
    return 1
  fi
  command -v lsof >/dev/null 2>&1 || { echo unknown; return 0; }
  while IFS= read -r line; do
    case "$line" in
      p*) pid="${line#p}" ;;
      n*) case "${line#n}/" in "$here/"*) echo "$pid"; return 0 ;; esac ;;
    esac
  done < <(lsof -a -c git -d cwd -Fpn 2>/dev/null)
  return 1
}
# .git/index.lock goes only when it is shown to be that checkout's own: the
# record names a git, that git is gone, the lock is no older than the record
# (the record is written first), it is not fresh, and no other git is running
# here. Anything else stays and is said.
# 0 clear to go on; 1 a git of this record's is running, or the lock is not its own.
clear_own_index_lock() {
  local word pid start named=0
  while read -r word pid start; do
    [ "$word" = git ] || continue
    named=1
    if [ -n "$start" ]; then [ "$start" != "$(proc_start "$pid")" ] || { echo "The checkout that deploy started is still running (pid $pid) — try again once it ends."; return 1; }
    elif kill -0 "$pid" 2>/dev/null; then echo "The checkout that deploy started is still running (pid $pid) — try again once it ends."; return 1; fi
  done < "$FROM_FILE"
  [ -e .git/index.lock ] || return 0
  local live
  if live="$(git_running_here)"; then
    if [ "$live" != unknown ]; then echo "$PWD/.git/index.lock is held by a git running there (pid $live), which this deploy did not start — try again once it ends."; return 1; fi
    named=0
  fi
  if [ "$named" = 1 ] && [ ! "$FROM_FILE" -nt .git/index.lock ] && [ -n "$(find .git/index.lock -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
    echo "Removing the .git/index.lock the deploy that was cut off left behind."
    rm -f .git/index.lock; return 0
  fi
  echo "$PWD/.git/index.lock is in the way, and nothing shows it is that deploy's own (one a few minutes old may be: try again then). If no git is running there, remove it: rm $PWD/.git/index.lock"
  return 1
}
# Back to the release the record names. Forced, and through the new one first
# when the tree is part-way: a checkout cut off leaves HEAD and the index on the
# old one with files rewritten, which a plain checkout kept (mixed code, then
# refused as local changes for good). The deploy started from a clean tree, and
# tracked files are all this touches, so .env and data/ stay. A tracked file
# that matches neither release may be someone's edit since the kill (or a file
# the kill cut short, which cannot be told apart): a copy is kept, and named.
save_other_edits() {
  local f got kept=""
  while IFS= read -r -d '' f; do
    [ -f "$f" ] || [ -L "$f" ] || continue
    got="$(git hash-object -- "$f" 2>/dev/null)" || got=""
    [ "$got" != "$(git rev-parse -q --verify "$FROM:$f" 2>/dev/null)" ] || continue
    [ -z "$TO" ] || [ "$got" != "$(git rev-parse -q --verify "$TO:$f" 2>/dev/null)" ] || continue
    if [ -z "$kept" ]; then
      kept="${FROM_FILE%.from}.kept-$(date +%Y%m%d-%H%M%S)"
      ( umask 077; mkdir -p "$kept" ) || { echo "Could not keep a copy of the edit to $f, so it was not overwritten."; return 1; }
      echo "These tracked files match neither $FROM nor ${TO:-the new release}, so they may be someone's edits. Putting $FROM back overwrites them; a copy of each is kept in $kept:"
    fi
    mkdir -p "$kept/$(dirname "$f")" && cp -pP "$f" "$kept/$f" || { echo "Could not keep a copy of the edit to $f, so it was not overwritten."; return 1; }
    echo "    $f"
  done < <(git --no-optional-locks diff --name-only -z HEAD 2>/dev/null)
  return 0
}
repair_tree() {
  [ -n "$FROM" ] || return 1
  save_other_edits || return 1
  if [ -n "$TO" ] && [ "$(git rev-parse HEAD)" != "$(git rev-parse "$TO^{commit}" 2>/dev/null)" ] && [ -n "$(git status --porcelain)" ]; then
    checkout_recorded --quiet --force "$TO" || return 1
  fi
  checkout_recorded --quiet --force "$FROM"
}
if [ -f "$FROM_FILE" ]; then
  FROM="$(sed -n 's/^from //p' "$FROM_FILE" | sed -n 1p)"; TO="$(sed -n 's/^to //p' "$FROM_FILE" | sed -n 1p)"
  echo "A deploy of $PROD was cut off part-way — putting ${FROM:-the previous release} back first."
  clear_own_index_lock || exit 3
  repair_tree || { echo "Could not check out ${FROM:-the previous release} (above): node_modules.prev holds its dependencies."; exit 3; }
  [ ! -d node_modules.prev ] || { rm -rf node_modules; mv node_modules.prev node_modules; }
  if grep -qx restarted "$FROM_FILE"; then systemctl --user restart "$SVC" || true; fi
  rm -f "$FROM_FILE"
fi
git fetch --tags --force --quiet origin || { echo "Could not fetch from $PROD's origin (above) — nothing was changed; try again later."; exit 3; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "Tag $TAG not found on origin."; exit 2; }
# Refusing is right; refusing without saying WHAT is not. An untracked stray —
# a note saved into the wrong directory — reads identically to a hand-edit here,
# and the operator can only act if the message names it.
if [ -n "$(git --no-optional-locks status --porcelain)" ]; then
  echo "$PROD has local changes — production must never be edited by hand. Refusing."
  echo
  git --no-optional-locks status --porcelain | sed 's/^/    /'
  echo
  echo "  ?? = an untracked file that does not belong to the release. If it is"
  echo "       something of yours, move it out:  mv $PROD/<file> ~/"
  echo "  Any other marker = a tracked file was edited in place. Restore it with"
  echo "       git -C $PROD checkout -- <file>   (your .env and data/ are untouched)"
  exit 2
fi
CUR="$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)"
echo "Deploying $TAG to $PROD (currently $CUR)…"
# `npm ci` wipes node_modules first: keep the working one aside until the new
# one is in, or an npm outage leaves prod with no dependencies (exit 3 = that;
# the old release is back untouched).
# Only once the working one was moved aside (ASIDE): stopped while a stale
# node_modules.prev was being removed, the rollback deleted the only working
# node_modules (HB-0266).
restore_deps() {
  if [ -d node_modules.prev ]; then rm -rf node_modules; mv node_modules.prev node_modules
  elif [ "$ASIDE" = 1 ]; then rm -rf node_modules; fi
  return 0
}
# The service is restarted only when it was restarted onto the new release:
# an install that failed left the old one serving, and restarting it anyway
# restarted production every ten minutes while a tag that cannot install kept
# failing (review, 2026-10-09).
# A checkout cut off part-way (a signal to the whole unit) leaves HEAD and the
# index on CUR with files rewritten, and a plain checkout of CUR kept them:
# mixed code, refused as local changes by every later deploy (HB-0266). Then
# the new tag first, and back, forced: tracked files only (the deploy started
# from a clean tree), so .env and data/ stay.
back_to_cur() {
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse "$TAG^{commit}")" ] && [ -n "$(git status --porcelain)" ]; then
    checkout_recorded --quiet --force "$TAG" || return 1
  fi
  checkout_recorded --quiet --force "$CUR"
}
rollback() {
  echo "Rolling back to ${CUR}…"
  # The dependencies go back whether or not the checkout could: left aside, the
  # running service had none until someone came. The record stays for the repair.
  local back=0
  back_to_cur || back=1
  restore_deps
  [ "$back" = 0 ] || return 1
  if [ "$RESTARTED" = 1 ]; then systemctl --user restart "$SVC" || return 1; fi
  rm -f "$FROM_FILE"
}
# The install upgrade.sh does: ensure-deps installs, compiles the database
# driver where its prebuilt one does not load (sqlite-driver.sh) and writes
# the stamp restart.sh checks — a bare `npm ci` did neither (review,
# 2026-10-09). A tag from before ensure-deps.sh gets npm ci.
install_deps() { if [ -x scripts/ensure-deps.sh ]; then ./scripts/ensure-deps.sh --quiet; else npm ci --silent; fi; }
INSTALL="${HATCHABOT_INSTALL_CMD:-install_deps}"   # overridable for tests only
# A deploy killed (or a power cut) right after moving node_modules aside left
# node_modules.prev as the only working copy. Put back first: deleted as a
# leftover, a failed install then had nothing to roll back to (audit #033).
[ -d node_modules ] || [ ! -d node_modules.prev ] || mv node_modules.prev node_modules
# A leftover, removed before the record is written: half removed under it,
# the next run's repair would move it in as the old release's.
rm -rf node_modules.prev
# Another git's lock, with nothing moved yet: the checkout would fail on it,
# and the rollback's too, with the dependencies aside (HB-0372).
[ ! -e .git/index.lock ] || { echo "$PWD/.git/index.lock is held, so nothing was changed — try again later. If no git is running there, remove it: rm $PWD/.git/index.lock"; exit 3; }
CHANGING=1
# pins-recorded: upgrade.sh reads this record too, and a deploy pins nothing, so a
# version in this install's channel file is the person's own (upgrade.sh, HB-0428).
printf 'from %s\nto %s\npins-recorded\n' "$CUR" "$TAG" > "$FROM_FILE"
if [ -d node_modules ]; then mv node_modules node_modules.prev; fi; ASIDE=1
checkout_recorded --quiet "$TAG"
# A failed install must not leave prod checked out at a tag it can't run.
$INSTALL || { CHANGING=0; rollback || true; exit 3; }
# node_modules.prev stays until the new release is SERVING: removed here, a
# failed health check's rollback found nothing to restore and left prod with
# no dependencies at all (night review, 2026-09-28).
RESTARTED=1; echo restarted >> "$FROM_FILE"
systemctl --user restart "$SVC" || { CHANGING=0; ROLLED_BACK=1; rollback || true; exit 1; }
WANT="$(node -e 'console.log(require("./package.json").version)')"
# Health URL from the production .env, not the caller's shell: PORT, native
# TLS and the bind address, read as the service reads them (restart.sh does
# the same) — the bare value, and the LAST line that sets it. The first was
# taken, so a .env that set PORT twice was probed on the old port (audit #031).
# (No .env is "not set": under pipefail sed's exit 2 for a missing file ended the deploy.)
# Spaces around the = too, as systemd reads it (PORT = 9137; audit, 2026-10-29).
envval() { { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env 2>/dev/null || true; } \
  | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e "s/^['\"]//" -e "s/['\"]$//" | tail -n1; }
P="$(envval PORT)"; P="${P:-8080}"
SCHEME=http; [ -n "$(envval HATCHABOT_TLS_CERT)" ] && SCHEME=https
# At the address it listens on when HATCHABOT_BIND is one host: a listener on
# a LAN address never answers 127.0.0.1, and a healthy release was rolled
# back — exit 1, which follow-latest sets aside for good (audit #030).
BIND="$(envval HATCHABOT_BIND)"
case "$BIND" in
  ""|0.0.0.0|127.0.0.1) PROBE_HOST=127.0.0.1 ;;
  ::|"[::]"|localhost) PROBE_HOST=localhost ;;
  \[*) PROBE_HOST="$BIND" ;;
  *:*) PROBE_HOST="[$BIND]" ;;   # an IPv6 address goes in brackets in a URL
  *) PROBE_HOST="$BIND" ;;
esac
URL="${HATCHABOT_HEALTH_URL:-$SCHEME://$PROBE_HOST:$P/}"
for i in $(seq 1 45); do
  GOT="$(curl -sk "$URL" 2>/dev/null | grep -oE 'HATCHABOT_VERSION="[^"]+"' | sed -n 1p | cut -d'"' -f2 || true)"
  # The record goes first: left behind beside a half-removed node_modules.prev,
  # the next deploy moved that in over the release now serving.
  [ "$GOT" = "$WANT" ] && { CHANGING=0; SERVING=1; rm -f "$FROM_FILE"; echo "Serving $GOT."; rm -rf node_modules.prev || true; exit 0; }
  sleep 2
done
echo "Service restarted but is not serving $WANT — check: journalctl --user -u $SVC -n 50"
CHANGING=0; ROLLED_BACK=1; rollback || true; exit 1
