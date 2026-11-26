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
# not retry this tag"; 2 refused (local changes, its helpers not found); 3
# did not complete (the install step, anything unplanned) with the previous
# release back; 4 another deploy or upgrade is running; 5 this machine had
# no room (a full disk) or no permission to write what the deploy needs (a
# read-only disk too), with the previous release back — try again, but it
# says nothing about the tag (HB-0470, as upgrade.sh). 5 only when the
# caller set HATCHABOT_FOLLOW_KNOWS_5=1 (follow-latest.sh does); to any other
# caller the disk is 3. 6 the release
# put back by an earlier deploy is not serving (its restart back did not come
# up, or was given up after three) and the tag named is that release: no tag
# was tried, and its record stays (kept_check, HB-1456). 6 only when the
# caller set HATCHABOT_FOLLOW_KNOWS_6=1; to any other it is 3.
set -euo pipefail
TAG="${1:?usage: deploy-release.sh vX.Y.Z}"
PROD="${HATCHABOT_PROD_DIR:-$HOME/hatchabot-prod}"
SVC="${HATCHABOT_SERVICE:-hatchabot}"
[ -d "$PROD/.git" ] || { echo "No production checkout at $PROD — clone the repo there first (docs/releasing.md)."; exit 2; }
# With CDPATH empty: an exported one made cd print the folder it found (two
# lines in HERE), or go to another folder of that name.
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)" || HERE=""
CDPATH= cd -- "$PROD"
# The helpers it shares with upgrade.sh (scripts/upgrade-helpers.sh: how a
# failed step's words are read, the records, the lock, the rollback's note),
# read once, here, before anything changes, and only the file this one was
# made with: HELPERS_BLOB is its git blob id (test/upgradeHelpers.test.ts
# holds it to that file). From the production checkout's git: the timer, any
# release's follow-latest.sh, runs this as a temporary copy of the tag's
# deploy script with nothing beside it, and that tag carries the file. Else,
# run from a checkout (by hand, hbt deploy) whose file that git has not got
# yet, from beside this one, once git says it is that file; never a file
# beside a temporary copy in a shared /tmp that no git vouches for. Found
# nowhere, this stops with nothing changed (2).
# Read from it: machine_short, free_mb, disk_words, said_kind, said_path,
# own_place, disk_short, step_tee, step_tail, new_step_log, run_step,
# step_short, put_rec, change_failed (a failed step's words); link_end,
# put_line, put_dir, put_failed (the records); proc_start, proc_start_utc,
# started_as, lock_left_over, take_lock, lock_short, lock_in_way (the lock);
# deps_holder_gone, deps_lock, deps_unlock; kept_tries, kept_record;
# checkout_recorded; older_release, mark_rolled_back, systemd_major,
# env_named, rolled_back_note, left_ran, unmark_rolled_back (the rollback's
# note).
HELPERS_BLOB=6cc1f1f8c134608439cbec85d58968a381df7195
# Read once, to the byte (the x keeps the newlines a $(…) drops at its end),
# and those bytes judged by their id before they are run.
HELPERS=""
if git --no-replace-objects cat-file -e "$HELPERS_BLOB" 2>/dev/null; then HELPERS="$(git --no-replace-objects cat-file blob "$HELPERS_BLOB" 2>/dev/null && printf x)" || HELPERS=""
elif [ -n "$HERE" ] && [ -f "$HERE/upgrade-helpers.sh" ]; then HELPERS="$(cat "$HERE/upgrade-helpers.sh" 2>/dev/null && printf x)" || HELPERS=""
fi
case "$HELPERS" in *x) HELPERS="${HELPERS%x}" ;; *) HELPERS="" ;; esac
[ -z "$HELPERS" ] || [ "$(printf '%s' "$HELPERS" | git hash-object --stdin 2>/dev/null)" = "$HELPERS_BLOB" ] || HELPERS=""
if [ -z "$HELPERS" ] || ! eval "$HELPERS" || ! declare -F upgrade_helpers_end >/dev/null; then
  echo "This deploy-release.sh needs scripts/upgrade-helpers.sh as its own release has it, and found it neither in $PWD's git nor beside it, so nothing was changed. Fetch the release into $PWD (git -C \"$PWD\" fetch --tags origin), or run scripts/deploy-release.sh from a whole checkout, then try again."
  exit 2
fi
unset HELPERS
# The names the helpers use: the tree, the release going in, and what to run
# when putting the old one back did not work.
# Absolute: a relative HATCHABOT_PROD_DIR named, after the cd, a folder that
# was not there, so df found no disk to judge (tenth review).
PROD="$PWD"; DIR="$PWD"; TARGET="$TAG"; REDO="scripts/deploy-release.sh $TAG"
# Whatever ends the script ends here. Something it did not plan for (set -e
# after node_modules was moved aside) left a half-changed checkout and exit 1,
# which follow-latest.sh reads as "this tag does not start" and never retries
# (review, 2026-10-09). Now the previous release is put back, and only an
# explicit rollback says 1. Set before the first step that can fail: a fetch
# that met another fetch's ref lock said 1 before anything was changed, and
# the tag was set aside for good (audit #032).
ROLLED_BACK=0; CHANGING=0; RESTARTED=0; ASIDE=0; SERVING=0; LOCK=""; STEP_LOG=""; STEP_SAID=""
DEPS_HELD=0   # 1 while this run holds the dependencies' lock (deps_lock)
DISK=0   # 1 once this run found the machine short of room or permission (machine_short)
KEPT=0   # 1 once this run ends on a release put back that is not serving (stop_or_go)
KEPT_REC=0   # 1 once this run goes on from that release's record, which its own takes the place of
finish() {
  local rc=$?
  set +e
  if [ "$rc" != 0 ] && [ "$CHANGING" = 1 ]; then CHANGING=0; rc=3; echo "The deploy stopped part-way — putting $CUR back."; rollback; fi
  # Stopped once the new release was serving (removing the old dependencies):
  # it is deployed, not a failure to try again (HB-0266). A node_modules.prev
  # left half removed goes with the next deploy.
  if [ "$SERVING" = 1 ]; then rm -f "$FROM_FILE"; rc=0; fi
  [ "$DEPS_HELD" != 1 ] || deps_unlock
  [ -z "$LOCK" ] || [ "$(cat "$LOCK/owner" 2>/dev/null)" != "$ME" ] || rm -rf "$LOCK"
  [ -z "$STEP_LOG" ] || rm -f "$STEP_LOG"
  # 5 only where this run found the disk (machine_short): any other 5 under set -e is 3.
  # And only for a caller that says it knows 5 (HATCHABOT_FOLLOW_KNOWS_5=1):
  # the timer that runs this is the release before's follow-latest.sh, and one
  # from before 5 read it as "try every tick", never backing off (seventh
  # review). To any other, the disk is 3, as it was.
  case "$rc" in 0|2|3|4) ;; 5) [ "$DISK" = 1 ] && [ "${HATCHABOT_FOLLOW_KNOWS_5:-}" = 1 ] || rc=3 ;; 6) [ "$KEPT" = 1 ] && [ "${HATCHABOT_FOLLOW_KNOWS_6:-}" = 1 ] || rc=3 ;; 1) [ "$ROLLED_BACK" = 1 ] || rc=3 ;; *) rc=3 ;; esac
  exit "$rc"
}
trap finish EXIT
# Stopped by a signal (`systemctl stop` of the timer's unit, a Ctrl-C, a closed
# terminal), bash ended without running finish: a deploy cut off in the
# install left prod on the new tag with half its dependencies and the old ones
# in node_modules.prev (HB-0266). Ended through exit, finish puts the old one
# back, as upgrade.sh does (HB-0043).
trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP
# A full disk, or a folder it cannot write, is this machine's, not the tag's:
# 5, which follow-latest.sh waits on and never sets a tag aside for. It said 3,
# and a disk that stayed full set a good release aside after eight ticks
# (third review of HB-0470). The same tests as upgrade.sh's, the helpers'
# (machine_short, run_step, step_short, change_failed).
# A record or a folder this deploy needs, written as upgrade.sh writes its
# own (put_line, put_dir): 0 done; 2 something not of its own in the way
# (PUT_PATH); 1 the write failed, its words in PUT_ERR. put_failed says
# which: in the way 2, else the machine's 5 (ninth review).
PUT_PATH=""; PUT_ERR=""
# The SAME lock upgrade.sh takes (a directory: mkdir is atomic everywhere,
# and macOS has no flock). A flock here and a mkdir there did not exclude each
# other, so `hbt upgrade` and the follow-latest timer could race one checkout's
# node_modules.prev (night review, 2026-09-28). Keyed on $PWD, as upgrade.sh
# is, and taken the same way: its holder written in it, and only a holder
# that is gone (or, with none written, an hour) makes it a leftover, cleared
# under a second lock (#226). In this user's state folder, not /tmp, where
# anyone on a shared host could make it first and stop every deploy (review,
# 2026-10-09).
LOCKS="${XDG_STATE_HOME:-$HOME/.local/state}/hatchabot"
PRC=0; put_dir "$LOCKS" || PRC=$?
[ "$PRC" = 0 ] || put_failed "$PRC" "Could not make $LOCKS, where deploys keep their lock (a full disk, or no permission there?): nothing was changed. Free some space or fix its permissions, then try again."
LOCK_PATH="$LOCKS/upgrade-$(printf %s "$PWD" | cksum | cut -d' ' -f1).lock.d"
ME="$$"; MY_START="$(proc_start $$)"; [ -z "$MY_START" ] || ME="$$ $MY_START"
ME_UTC="$$ $(proc_start_utc $$)"

LOCK_RC=0; take_lock || LOCK_RC=$?
[ "$LOCK_RC" != 2 ] || lock_short
if [ "$LOCK_RC" != 0 ]; then
  [ -z "$(find "$LOCK_PATH.clearing" -maxdepth 0 -mmin +10 2>/dev/null)" ] || rmdir "$LOCK_PATH.clearing" 2>/dev/null || true
  if [ -d "$LOCK_PATH" ] && lock_left_over && mkdir "$LOCK_PATH.clearing" 2>/dev/null; then
    if lock_left_over; then rm -rf "$LOCK_PATH"; fi
    rmdir "$LOCK_PATH.clearing" 2>/dev/null || true
  fi
  LOCK_RC=0; take_lock || LOCK_RC=$?
  [ "$LOCK_RC" != 2 ] || lock_short
  lock_in_way
  [ "$LOCK_RC" = 0 ] || { echo "Another deploy or upgrade of $PROD is running (lock $LOCK_PATH)."; exit 4; }
fi
# The dependencies' own lock, ensure-deps.sh's, held while node_modules is
# moved aside or put back, as upgrade.sh holds it (HB-1212): moved without
# it, a restart's npm ci running there meanwhile had its tree moved from
# under it (review of HB-1212). deps_lock and deps_unlock, as upgrade.sh's;
# let go before every restart, whose ensure-deps.sh takes it, and in finish.
DEPS_LOCK="$LOCKS/deps-$(printf %s "$DIR" | cksum | cut -d' ' -f1).lock.d"
DEPS_ME="$$"; DEPS_START="$(proc_start_utc $$)"; [ -z "$DEPS_START" ] || DEPS_ME="$$ $DEPS_START"
# How many one-second tries the lock is waited for: half an hour (tests make it a few).
DEPS_WAIT="${HATCHABOT_DEPS_WAIT_SECS:-1800}"; case "$DEPS_WAIT" in ''|*[!0-9]*) DEPS_WAIT=1800 ;; esac
DEPS_STUCK="Another install of the dependencies in $DIR has held $DEPS_LOCK for half an hour, so nothing was moved. If no npm is running there, remove it (rm -r \"$DEPS_LOCK\"), then try again."

# A deploy in progress, beside the lock, in the record upgrade.sh keeps
# (its FROM_FILE, the same file for the same checkout): `from <release>`, then
# `restarted` once the service was restarted onto the new one (and `started`:
# left_ran). Left behind,
# the run was killed part-way (SIGKILL, a power cut): the checkout may be on
# the new tag with half its dependencies, and the old ones in
# node_modules.prev. Put the old release back first, then deploy as usual
# (HB-0266).
FROM_FILE="${LOCK_PATH%.lock.d}.from"
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
    if [ -n "$start" ]; then ! started_as "$pid" "$start" || { echo "The checkout that deploy started is still running (pid $pid) — try again once it ends."; return 1; }
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
NOTED=0   # 1 once this run wrote the rollback's note for an older tag (mark_rolled_back)
repair_tree() {
  [ -n "$FROM" ] || return 1
  save_other_edits || return 1
  if [ -n "$TO" ] && [ "$(git rev-parse HEAD)" != "$(git rev-parse "$TO^{commit}" 2>/dev/null)" ] && [ -n "$(git status --porcelain)" ]; then
    checkout_recorded --quiet --force "$TO" || return 1
  fi
  checkout_recorded --quiet --force "$FROM"
}
# serving_wait [once]: 0 once the service serves the release checked out
# (WANT, its package.json's version), 1 when it has not in 90 seconds; with
# `once`, asked once (kept_check). The deploy's own wait, and the restart
# back's of a rollback or a repair: not waited for, one that did not come up
# had its record removed all the same, and nothing tried again (HB-1456). An
# empty WANT (no node, or a package.json it cannot read) is never served: it
# matched a service that did not answer at all. WANT_SAID says it either way.
# Health URL from the production .env, not the caller's shell: PORT, native
# TLS and the bind address, read as the service reads them (restart.sh does
# the same) — the bare value, and the LAST line that sets it. The first was
# taken, so a .env that set PORT twice was probed on the old port (audit #031).
# (No .env is "not set": under pipefail sed's exit 2 for a missing file ended the deploy.)
# Spaces around the = too, as systemd reads it (PORT = 9137; audit, 2026-10-29).
envval() { { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env 2>/dev/null || true; } \
  | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e "s/^['\"]//" -e "s/['\"]$//" | tail -n1; }
serving_wait() {
  local p scheme bind PROBE_HOST url got DEADLINE i n=45
  [ "${1:-}" != once ] || n=1
  WANT="$(node -e 'console.log(require("./package.json").version)' 2>/dev/null || true)"
  WANT_SAID="${WANT:-the version in its package.json (which could not be read)}"
  p="$(envval PORT)"; p="${p:-8080}"
  scheme=http; [ -z "$(envval HATCHABOT_TLS_CERT)" ] || scheme=https
  # At the address it listens on when HATCHABOT_BIND is one host: a listener on
  # a LAN address never answers 127.0.0.1, and a healthy release was rolled
  # back — exit 1, which follow-latest sets aside for good (audit #030).
  bind="$(envval HATCHABOT_BIND)"
  case "$bind" in
    ""|0.0.0.0|127.0.0.1) PROBE_HOST=127.0.0.1 ;;
    ::|"[::]"|localhost) PROBE_HOST=localhost ;;
    \[*) PROBE_HOST="$bind" ;;
    *:*) PROBE_HOST="[$bind]" ;;   # an IPv6 address goes in brackets in a URL
    *) PROBE_HOST="$bind" ;;
  esac
  url="${HATCHABOT_HEALTH_URL:-$scheme://$PROBE_HOST:$p/}"
  # Each request has its own deadline, and the wait a total one: a listener that
  # took the connection and never answered held one curl with no end, the
  # rollback never came, and the upgrade lock stayed held (HB-0553).
  DEADLINE=$((SECONDS + 90))
  for i in $(seq 1 "$n"); do
    got="$(curl -sk --connect-timeout 3 --max-time 10 "$url" 2>/dev/null | grep -oE 'HATCHABOT_VERSION="[^"]+"' | sed -n 1p | cut -d'"' -f2 || true)"
    [ -z "$WANT" ] || [ "$got" != "$WANT" ] || return 0
    [ "$i" -lt "$n" ] && [ "$SECONDS" -lt "$DEADLINE" ] || break
    sleep 2
  done
  return 1
}
# A restart back that did not come up keeps its record, as upgrade.sh's does
# (kept_check there, HB-1456): asked once first whether it serves now, then
# restarted again, KEPT_MAX times in all (`tries`), then left for a person.
# A deploy of another tag goes on, its record in the place of this one; a
# deploy of the tag put back has nothing more to do: 6.
KEPT_MAX=3
# Counted are tries: one systemctl refused restarted nothing, and is counted
# all the same, so a service manager that refuses every time is not asked for ever.
kept_stop() { echo "$1 is back in $PROD, but it has not come up after $2 tries to restart it, so deploys stop restarting it (a rollback to it from another release still does). Once what stops it is fixed (journalctl --user -u $SVC -n 50 says why), remove the record and restart it: rm \"$FROM_FILE\"; systemctl --user restart $SVC"; }
# back_down RELEASE SAID: RELEASE, put back, is not serving (SAID): counted, and said.
back_down() {
  local n
  n=$(( $(kept_tries "$FROM_FILE") + 1 ))
  printf 'tries %s\n' "$n" >> "$FROM_FILE" 2>/dev/null || true
  if [ "$n" -lt "$KEPT_MAX" ]; then echo "$2 $FROM_FILE stays: the next deploy restarts it again if it is still not serving ($n of $KEPT_MAX)."
  else kept_stop "$1" "$n"; fi
}
# kept_check RELEASE: 0 when it serves now (the record goes, nothing is
# restarted), 2 when it was restarted KEPT_MAX times already, 1 to restart it
# again. Asked only once the service manager restarted it (`back`): before,
# what answers may be the tag left, still running.
kept_check() {
  local n
  if grep -qx back "$FROM_FILE" 2>/dev/null && serving_wait once; then echo "$1 is back in $PROD and serving now, so $FROM_FILE is removed."; rm -f "$FROM_FILE"; return 0; fi
  n="$(kept_tries "$FROM_FILE")"
  [ "$n" -lt "$KEPT_MAX" ] || { kept_stop "$1" "$n"; return 2; }
  return 1
}
# stop_or_go RELEASE: RELEASE, put back, is not serving. A deploy of another
# tag goes on (its record takes the place of this one: went_on says so once
# it has; kept_again if it goes back before restarting anything); one of
# RELEASE ends 6.
stop_or_go() {
  if [ "$TAG" != "$1" ]; then
    KEPT_REC=1; KEPT_FROM="${1:-the release put back}"; KEPT_SAVED="$(cat "$FROM_FILE" 2>/dev/null || true)"
    return 0
  fi
  KEPT=1; exit 6
}
# went_on: said once this deploy's own record has taken the place of the one
# kept. Said in stop_or_go, the deploy could still end (2, 3) with that
# record as it was, and the words untrue.
went_on() { [ "$KEPT_REC" = 0 ] || echo "Going on to $TAG, which may come up where $KEPT_FROM does not: this deploy's own record has taken the place of $FROM_FILE."; }
kept_again() {
  put_line "$FROM_FILE" "$KEPT_SAVED" || { echo "Could not write $FROM_FILE again (${PUT_ERR:-$PUT_PATH is in the way}), so nothing restarts $KEPT_FROM: once that is fixed, run systemctl --user restart $SVC"; return 0; }
  echo "$FROM_FILE stays for the next run: $KEPT_FROM is still not serving."
}
# restarted_back RELEASE: the service manager restarted RELEASE, put back:
# `back` in the record, so a repair after it writes no note (left_ran), as
# restart.sh writes it for upgrade.sh; then waited for (serving_wait). 1 when
# it did not come up, said: the record stays, for the next deploy (HB-1456).
restarted_back() {
  LC_ALL=C put_rec "$FROM_FILE" '>>' back 2>/dev/null || echo "Could not write \"back\" in $FROM_FILE (a full disk?), so the next deploy may write this rollback down again."
  serving_wait && return 0
  back_down "$1" "$1 is back in $PROD, but it is not serving $WANT_SAID — check: journalctl --user -u $SVC -n 50."
  return 1
}
if [ -f "$FROM_FILE" ]; then
  FROM="$(sed -n 's/^from //p' "$FROM_FILE" | sed -n 1p)"; TO="$(sed -n 's/^to //p' "$FROM_FILE" | sed -n 1p)"
  if kept_record "$FROM_FILE"; then echo "${FROM:-The previous release} was put back in $PROD by an earlier run, whose restart of it did not come up or was cut off."
  else echo "A deploy of $PROD was cut off part-way — putting ${FROM:-the previous release} back first."; fi
  clear_own_index_lock || exit 3
  repair_tree || { echo "Could not check out ${FROM:-the previous release} (above): node_modules.prev holds its dependencies."; exit 3; }
  if [ -d node_modules.prev ]; then
    deps_lock || { echo "Another install of the dependencies in $DIR has held $DEPS_LOCK for half an hour, so ${FROM:-the previous release}'s are still in node_modules.prev, not put back: the next deploy puts them back first. If no npm is running there, remove it: rm -r \"$DEPS_LOCK\""; exit 3; }
    rm -rf node_modules; mv node_modules.prev node_modules
    deps_unlock
  fi
  # Written down only if the new release really ran and nothing went back
  # since (left_ran). A note written for an older tag named, which never
  # started, goes as that run's rollback would have taken it away
  # (unmark_rolled_back, HB-1455); one that started, the rollback saw to.
  GOING=0
  if grep -qx restarted "$FROM_FILE"; then
    NOTED_AT="$(sed -n 's/^noted //p' "$FROM_FILE" | tail -n 1)"
    if left_ran "$FROM_FILE"; then mark_rolled_back "$DIR"; elif [ -n "$NOTED_AT" ] && ! grep -qx started "$FROM_FILE"; then unmark_rolled_back "$DIR" "$NOTED_AT"; fi
    KC=0; kept_check "${FROM:-The previous release}" || KC=$?
    if [ "$KC" = 1 ]; then
      # One the service manager could not restart may still be serving: the wait says.
      if systemctl --user restart "$SVC"; then restarted_back "${FROM:-The previous release}" || { stop_or_go "$FROM"; GOING=1; }
      elif ! serving_wait; then
        back_down "${FROM:-The previous release}" "Could not restart $SVC onto ${FROM:-the previous release} (above), and it is not serving $WANT_SAID."
        stop_or_go "$FROM"; GOING=1
      fi
    elif [ "$KC" = 2 ]; then stop_or_go "$FROM"; GOING=1; fi
  fi
  [ "$GOING" = 1 ] || rm -f "$FROM_FILE"
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
# Under the dependencies' lock, as upgrade.sh's: one this run cannot have
# within half an hour leaves them where they are and fails, so the record
# stays and the next deploy puts them back (review of HB-1212).
restore_deps() {
  [ -d node_modules.prev ] || [ "$ASIDE" = 1 ] || return 0
  if ! deps_lock; then
    echo "Another install of the dependencies in $DIR has held $DEPS_LOCK for half an hour, so ${CUR:-the previous release}'s were left in node_modules.prev, not put back. If no npm is running there, remove it: rm -r \"$DEPS_LOCK\""
    return 1
  fi
  if [ -d node_modules.prev ]; then rm -rf node_modules; mv node_modules.prev node_modules
  elif [ "$ASIDE" = 1 ]; then rm -rf node_modules; fi
  deps_unlock
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
  restore_deps || back=1
  [ "$back" = 0 ] || return 1
  # Written down only if the new release really ran (left_ran); a note this
  # run wrote for an older tag named that never started goes (NOTED).
  if [ "$RESTARTED" = 1 ]; then
    if left_ran "$FROM_FILE"; then mark_rolled_back "$DIR"; elif [ "$NOTED" = 1 ]; then unmark_rolled_back "$DIR"; fi
    NOTED=0
    systemctl --user restart "$SVC" || return 1
    restarted_back "$CUR" || { BACK_DOWN=1; return 1; }
  fi
  if [ "$RESTARTED" = 0 ] && [ "$KEPT_REC" = 1 ]; then kept_again; else rm -f "$FROM_FILE"; fi
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
# From here to the move aside below, under the dependencies' lock: taken
# before the record, so one this run cannot have changes nothing.
deps_lock || { echo "$DEPS_STUCK"; exit 3; }
[ -d node_modules ] || [ ! -d node_modules.prev ] || mv node_modules.prev node_modules
# A leftover, removed before the record is written: half removed under it,
# the next run's repair would move it in as the old release's.
rm -rf node_modules.prev
# Another git's lock, with nothing moved yet: the checkout would fail on it,
# and the rollback's too, with the dependencies aside (HB-0372).
[ ! -e .git/index.lock ] || { echo "$PWD/.git/index.lock is held, so nothing was changed — try again later. If no git is running there, remove it: rm $PWD/.git/index.lock"; exit 3; }
# pins-recorded: upgrade.sh reads this record too, and a deploy pins nothing, so a
# version in this install's channel file is the person's own (upgrade.sh, HB-0428).
# Written before anything moves, so a disk too full for it changes nothing.
PRC=0; put_line "$FROM_FILE" "from $CUR" "to $TAG" pins-recorded says-started || PRC=$?
[ "$PRC" = 0 ] || put_failed "$PRC" "Could not write $FROM_FILE (a full disk, or no permission there?), so nothing was changed. Free some space, then try again."
went_on
CHANGING=1
if [ -d node_modules ]; then mv node_modules node_modules.prev; fi; ASIDE=1
deps_unlock
# A rollback once the service was restarted, which did not work (the
# dependencies' lock held, a checkout, the old release's restart): the record
# stays and the next run repairs from it. Said, with what to run, as
# change_failed says it; it ended with exit 1 and no next step (review of
# HB-1212). Still 1: the release itself did not come up.
# Back, and only its restart did not come up: restarted_back said what comes next.
BACK_DOWN=0
rollback_or_redo() {
  rollback && return 0
  [ "$BACK_DOWN" = 1 ] || echo "Then run $REDO: it puts ${CUR:-the previous release} back first, from its record."
}
# As upgrade.sh: the step's errors beside the lock, not in TMPDIR (which may
# be the same full disk) unless that folder takes no new file (new_step_log),
# and in English, so disk_short reads them (fourth review).
STEP_LOG="$(new_step_log)"
LC_ALL=C run_step checkout_recorded --quiet "$TAG" || change_failed rollback "checked out" "The deploy stopped part-way — putting $CUR back."
# A failed install must not leave prod checked out at a tag it can't run.
# The install's messages in English, which the step's words are judged by, and
# the rest of the locale the user's: LC_ALL=C over the whole install set every
# category, and builds lost the user's (fourteenth review). The user's LC_ALL,
# which would override LC_MESSAGES, becomes LANG, the fallback for the rest.
LANG="${LC_ALL:-${LANG-}}" LC_ALL= LC_MESSAGES=C run_step $INSTALL || change_failed rollback installed
# node_modules.prev stays until the new release is SERVING: removed here, a
# failed health check's rollback found nothing to restore and left prod with
# no dependencies at all (night review, 2026-09-28).
LC_ALL=C run_step put_rec "$FROM_FILE" '>>' restarted || change_failed rollback started "Could not write $FROM_FILE (above)."
RESTARTED=1
# Going back by naming an older tag is a rollback too (mark_rolled_back).
if older_release "$TAG" "$CUR"; then mark_rolled_back "$DIR" "$FROM_FILE"; NOTED=1; fi
systemctl --user restart "$SVC" || { CHANGING=0; ROLLED_BACK=1; rollback_or_redo || true; exit 1; }
# The service manager has restarted it onto the new tag (left_ran).
LC_ALL=C put_rec "$FROM_FILE" '>>' started 2>/dev/null || echo "Could not write \"started\" in $FROM_FILE (a full disk?), so a rollback from here may not be written down for the next start."
# The record goes first: left behind beside a half-removed node_modules.prev,
# the next deploy moved that in over the release now serving.
if serving_wait; then CHANGING=0; SERVING=1; rm -f "$FROM_FILE"; echo "Serving $WANT."; rm -rf node_modules.prev || true; exit 0; fi
echo "Service restarted but is not serving $WANT_SAID — check: journalctl --user -u $SVC -n 50"
CHANGING=0; ROLLED_BACK=1; rollback_or_redo || true; exit 1
