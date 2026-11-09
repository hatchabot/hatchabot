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
# deploy or upgrade is running; 5 this machine had no room (a full disk) or no
# permission to write what the deploy needs (a read-only disk too), with the
# previous release back — try again, but it says nothing about the tag
# (HB-0470, as upgrade.sh). 5 only when the caller set HATCHABOT_FOLLOW_KNOWS_5=1
# (follow-latest.sh does); to any other caller the disk is 3.
set -euo pipefail
TAG="${1:?usage: deploy-release.sh vX.Y.Z}"
PROD="${HATCHABOT_PROD_DIR:-$HOME/hatchabot-prod}"
SVC="${HATCHABOT_SERVICE:-hatchabot}"
[ -d "$PROD/.git" ] || { echo "No production checkout at $PROD — clone the repo there first (docs/releasing.md)."; exit 2; }
cd "$PROD"
# The names upgrade.sh's helpers use (change_failed, put_failed and the rest
# are copies, held equal by test/nightScripts.test.ts): the tree, the release
# going in, and what to run when putting the old one back did not work.
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
DISK=0   # 1 once this run found the machine short of room or permission (machine_short)
finish() {
  local rc=$?
  set +e
  if [ "$rc" != 0 ] && [ "$CHANGING" = 1 ]; then CHANGING=0; rc=3; echo "The deploy stopped part-way — putting $CUR back."; rollback; fi
  # Stopped once the new release was serving (removing the old dependencies):
  # it is deployed, not a failure to try again (HB-0266). A node_modules.prev
  # left half removed goes with the next deploy.
  if [ "$SERVING" = 1 ]; then rm -f "$FROM_FILE"; rc=0; fi
  [ -z "$LOCK" ] || [ "$(cat "$LOCK/owner" 2>/dev/null)" != "$ME" ] || rm -rf "$LOCK"
  [ -z "$STEP_LOG" ] || rm -f "$STEP_LOG"
  # 5 only where this run found the disk (machine_short): any other 5 under set -e is 3.
  # And only for a caller that says it knows 5 (HATCHABOT_FOLLOW_KNOWS_5=1):
  # the timer that runs this is the release before's follow-latest.sh, and one
  # from before 5 read it as "try every tick", never backing off (seventh
  # review). To any other, the disk is 3, as it was.
  case "$rc" in 0|2|3|4) ;; 5) [ "$DISK" = 1 ] && [ "${HATCHABOT_FOLLOW_KNOWS_5:-}" = 1 ] || rc=3 ;; 1) [ "$ROLLED_BACK" = 1 ] || rc=3 ;; *) rc=3 ;; esac
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
# (third review of HB-0470). The same tests as upgrade.sh's.
# Copies of upgrade.sh's, not one file both source: this runs from a
# temporary copy of itself while the checkout changes scripts/ under it, and a
# sourced file missing or half-changed there would stop a deploy before it
# could put the release back. test/nightScripts.test.ts holds them equal.
machine_short() { DISK=1; exit 5; }
free_mb() { df -Pk "$1" 2>/dev/null | awk 'END { if (NF >= 4 && $4 ~ /^[0-9]+$/) printf "%d", $4 / 1024 }' || true; }
# disk_words TEXT: whether TEXT says the disk is full: no room, a quota
# (EDQUOT), or ENOSPC; not the ENOSPC Linux says when the inotify watcher limit
# is reached ("System limit for number of file watchers reached"), which is no
# reason to pass a release over (second review of HB-0470). One list: said_kind
# reads it, and follow-latest.sh keeps a copy for git's words, where its own
# list missed EDQUOT and a bare ENOSPC (fifteenth review).
disk_words() {
  case "$1" in
    *[Nn]"o space left on device"*|*[Dd]"isk quota"*|*EDQUOT*) return 0 ;;
    *"file watchers"*) return 1 ;;
    *ENOSPC*) return 0 ;;
  esac
  return 1
}
# What a failed step's words say: "disk" (no room, a quota), "denied" (no
# permission to write, a read-only disk: the machine's too, tenth review),
# "own" (words of another failure, a file it could not run among them:
# eleventh review), or nothing (it said nothing). said_kind TEXT
# The words, not the code: the disk's as disk_words reads them.
said_kind() {
  # Line by line: pieces on two lines ("spawn" on one, EACCES on another) made
  # one match across them (twelfth review). Not a here-string, which bash 3.2
  # writes to a temporary file, on the disk that may be full.
  local line p run=0 deny=0 out=0 anon=0 short=0 fail=0 said=0 glob=1 IFS='
'
  case "$-" in *f*) glob=0 ;; esac
  set -f
  for line in $1; do
    case "$line" in *[![:space:]]*) said=1 ;; *) continue ;; esac
    # The disk's words are read in the whole text, below (disk_words).
    ! disk_words "$line" || continue
    case "$line" in
      *"file watchers"*) ;;
      # A warning decides nothing, a WARN EACCES no more than another: gyp's
      # for its dev dir ("gyp WARN EACCES current user ("u") does not have
      # permission to access the dev dir "/root/.cache/node-gyp/…"") is said
      # on the way to a build that may fail on its own, and called that
      # failure the machine's (fifteenth review). Its disk words still count
      # (npm says a full disk as "npm WARN tar ENOSPC").
      "WARN "*|*" WARN "*|*"npm warn "*|*[Ww]"arning: "*) ;;
      *"Permission denied (publickey"*) ;;
      *" code 126"*|*"spawn "*EACCES*|*"sh: "[0-9]*": Permission denied"*|*"cannot execute"*) run=1 ;;
      # Bash's own words, the same for a file it could not run and a
      # redirection it could not write: the path decides. A file in this
      # release's tree, there and not executable, is one it could not run;
      # unless this user may not write it either (a record of the install's
      # made read-only), as a redirection's would be.
      *": line "[0-9]*": "*": Permission denied"*)
        p="${line%: Permission denied*}"; p="${p##*: }"
        case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
        case "$p" in "${DIR:-$PWD}"/*) if [ -f "$p" ] && [ ! -x "$p" ] && [ -w "$p" ]; then run=1; else deny=1; fi ;; *) if own_place "$p"; then deny=1; else out=1; fi ;; esac ;;
      # A write it was refused, judged by where: in one of this install's own
      # places the machine's, anywhere else (/usr/local) the release's own
      # write (fourteenth review). A line that names no place ("npm error
      # code EACCES") goes by those that do, and by the step's own words of
      # failure (below): the machine's only when there are neither.
      *[Pp]"ermission denied"*|*EACCES*|*[Rr]"ead-only file system"*|*EROFS*)
        p="$(said_path "$line")"
        if [ -z "$p" ]; then anon=1; elif own_place "$p"; then deny=1; else out=1; fi ;;
      *"Broken pipe"*) ;;
      *[Uu]"nable to write"*|*[Ww]"rite error"*|*[Ss]"hort write"*) short=1 ;;
      # The step's own failure in its own words: gyp's, a compiler's, make's.
      # They outrank a permission line that names no place (fifteenth review).
      *"gyp ERR!"*|*": error: "*|*"fatal error: "*|*"make: *** "*|*"make["[0-9]*"]: *** "*) fail=1 ;;
    esac
  done
  [ "$glob" = 0 ] || set +f
  if disk_words "$1"; then echo disk
  elif [ "$run" = 1 ]; then echo own
  elif [ "$deny" = 1 ]; then echo denied
  elif [ "$out" = 1 ]; then echo own
  elif [ "$short" = 1 ]; then echo disk
  elif [ "$fail" = 1 ]; then echo own
  elif [ "$anon" = 1 ]; then echo denied
  elif [ "$said" = 1 ]; then echo own
  fi
}
# The path that "denied" words name ('' when they name none): of the lines
# that say it, the first that names one, the last quoted ('…', as mv, mkdir,
# git and Node quote them in English; else "…", as gyp and others do:
# fifteenth review), else the one just before ": Permission
# denied" that looks like one, with a / or a dot (bash's own redirections,
# git's "unable to create file"). said_path TEXT
said_path() {
  local p t w='[Pp]ermission denied|EACCES|[Rr]ead-only file system|EROFS'
  # Not a warning's (said_kind): gyp's WARN names its dev dir, though the step
  # may fail for another reason.
  t="$(printf '%s\n' "$1" | grep -vE '(^| )WARN |npm warn |[Ww]arning: ' || true)"
  p="$(printf '%s\n' "$t" | sed -nE -e "/$w/s/.*'([^']+)'.*/\\1/p" -e "/$w/s/.*\"([^\"]+)\".*/\\1/p" | sed -n 1p)"
  [ -n "$p" ] || p="$(printf '%s\n' "$t" | sed 's/^/ /' | sed -nE 's/.*[[:space:]]([^[:space:]:]*[/.][^[:space:]:]*): ([Pp]ermission denied|[Rr]ead-only file system).*/\1/p' | sed -n 1p)"
  printf '%s\n' "$p"
}
# own_place PATH: in one of this install's own places, where a write it was
# refused is the machine's (5): the install, its state folder, npm's and
# node-gyp's caches in HOME, TMPDIR. Anywhere else (/usr/local, another
# user's folder) it is the release's own write, 3 (fourteenth review). A
# relative PATH is the step's, from here.
own_place() {
  local p="$1" q
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  for q in "${DIR:-$PWD}" "${XDG_STATE_HOME:-$HOME/.local/state}/hatchabot" "$HOME/.npm" "$HOME/.cache/node-gyp" "$HOME/.node-gyp" "${TMPDIR:-/tmp}"; do
    q="${q%/}"
    case "$p" in "$q"|"$q"/*) return 0 ;; esac
  done
  return 1
}
# Whether a step that failed did so for want of room: its words say the
# disk, or the disk holding PATH has next to nothing left (under 64 MB),
# whatever else it said. A full disk does not always say so: git's "unable to
# write new index file" names no errno (eighth review; the sixth had words of
# its own win on a nearly full disk). disk_short PATH [OUTPUT]
# Under 64 MB any failure is the disk's, on purpose (eleventh review): on a
# disk that nearly full a step's words cannot be trusted (it may have died
# writing its own error), and freeing space is needed before anything else.
disk_short() {
  [ "$(said_kind "${2:-}")" != disk ] || return 0
  local mb
  mb="$(free_mb "$1")"
  [ -n "$mb" ] && [ "$mb" -lt 64 ]
}
# A step's errors, shown as before and kept in STEP_LOG (tee, not a bash loop
# that opened the log for every line: eleventh review). The step is not run
# inside $(…), which made it a grandchild of this script. The log may not be
# writable on the full disk it would show, so the step's last lines are kept
# in memory too (step_tail: 20 lines, 2 KB at most) and judged there
# (said_kind); what they said comes back as the reader's status, the only way
# out of a pipeline, into STEP_SAID (sixth review). Only the last lines, which
# hold the error that ended the step: a warning early on (gyp's "WARN EACCES"
# for its dev dir) decided a compile error's exit (eleventh review). awk shows
# each line as it comes, through its own name for stderr: /dev/stderr opened
# as a path fails on Linux when stderr is the journal's socket.
step_tee() {
  local kept
  kept="$( { if [ -n "$STEP_LOG" ]; then tee -a "$STEP_LOG" 2>/dev/null; else cat; fi; } \
    | awk '{ print > "/dev/stderr"; fflush("/dev/stderr"); print }' | step_tail )" || true
  case "$(said_kind "$kept")" in disk) return 20 ;; own) return 21 ;; denied) return 22 ;; esac
  return 0
}
step_tail() { tail -n 20 | tail -c 2048; }
# The step log, beside the lock (not TMPDIR, which may be the same full disk:
# fourth review); where that folder takes no new file, in TMPDIR after all,
# so the path a permission names can still be read back (twelfth review: the
# memory's verdict leaves its pipeline as a status only, since the step must
# stay this script's own child). '' when neither can be made.
new_step_log() { mktemp "${LOCK_PATH%.lock.d}.step.XXXXXX" 2>/dev/null || mktemp "${TMPDIR:-/tmp}/hatchabot-step.XXXXXX" 2>/dev/null || true; }
run_step() {
  local st e=0
  # Judged by its own words only: an earlier step's warning in the log must
  # not decide this one's failure (seventh review).
  STEP_SAID=""
  [ -z "$STEP_LOG" ] || { : > "$STEP_LOG"; } 2>/dev/null || true
  # Read with errexit off: under set -euo pipefail a step that succeeded and
  # said something (step_tee's verdict, 20 to 22) failed the pipeline, and a
  # run_step not in a condition ended the script (fourteenth review).
  case "$-" in *e*) e=1; set +e ;; esac
  { "$@" 2>&1 1>&3 | step_tee; st="${PIPESTATUS[0]} ${PIPESTATUS[1]}"; } 3>&1
  [ "$e" = 0 ] || set -e
  case "${st#* }" in 20) STEP_SAID=disk ;; 21) STEP_SAID=own ;; 22) STEP_SAID=denied ;; esac
  # 126: a file it found and could not run, the release's own, 3 (eleventh
  # review), unless its words named the disk or a permission of the
  # machine's: bash's own "Permission denied" names a path, and said_kind
  # judged by it (a noexec mount, a file outside the release: twelfth review).
  [ "${st%% *}" != 126 ] || [ "$STEP_SAID" = disk ] || [ "$STEP_SAID" = denied ] || STEP_SAID=own
  return "${st%% *}"
}
# The step run last: the machine's (0) when its last words, as kept in memory
# (STEP_SAID; the log's last lines only when there is nothing there: the log
# may have stopped taking lines part-way, on the very disk that filled, eighth
# review) say the disk or a permission on writing (SHORT_WHY=denied,
# SHORT_PATH the path the log names: tenth review), else as disk_short judges
# (SHORT_WHY=disk). step_short PATH
step_short() {
  local said kind
  said="$( { step_tail < "$STEP_LOG"; } 2>/dev/null)" || said=""
  kind="${STEP_SAID:-$(said_kind "$said")}"
  SHORT_WHY=disk; SHORT_PATH=""
  [ "$kind" != disk ] || return 0
  if [ "$kind" = denied ]; then
    SHORT_WHY=denied; SHORT_PATH="$(said_path "$said")"
    return 0
  fi
  disk_short "$1"
}
put_rec() {
  local LC_ALL=C f="$1" how="$2"
  shift 2
  if [ "$how" = '>' ]; then printf '%s\n' "$@" > "$f"; else printf '%s\n' "$@" >> "$f"; fi
}
# A record or a folder this deploy needs, written as upgrade.sh writes its
# own (link_end, put_line, put_dir: copies, as above): 0 done; 2 something
# not of its own in the way (PUT_PATH); 1 the write failed, its words in
# PUT_ERR. put_failed says which: in the way 2, else the machine's 5 (ninth
# review).
PUT_PATH=""; PUT_ERR=""
link_end() {
  local p="$1" l n=0
  while [ -L "$p" ]; do
    [ "$n" -lt 40 ] || return 1
    l="$(readlink "$p")" || return 1
    case "$l" in /*) p="$l" ;; *) p="$(dirname "$p")/$l" ;; esac
    n=$((n + 1))
  done
  printf '%s\n' "$p"
}
put_line() {
  local p f="$1" end
  shift
  PUT_PATH=""; PUT_ERR=""
  if [ -L "$f" ]; then
    end="$(link_end "$f")" && [ -f "$end" ] || { PUT_PATH="$f"; return 2; }
    f="$end"
  fi
  for p in "$f" "$f.tmp"; do
    if [ -L "$p" ] || { [ -e "$p" ] && [ ! -f "$p" ]; }; then PUT_PATH="$p"; return 2; fi
  done
  # In English, for disk_short (exported: mkdir and mv say it too, sixth
  # review); kept, not shown, until put_failed says it.
  PUT_ERR="$( { export LC_ALL=C; mkdir -p "$(dirname "$f")" && printf '%s\n' "$@" > "$f.tmp" && mv -f "$f.tmp" "$f"; } 2>&1 )" && return 0
  rm -f "$f.tmp" 2>/dev/null || true
  # A file where a folder above it goes is in the way too, as put_dir finds
  # it: mkdir's "File exists" read as the disk (tenth review).
  local err="$PUT_ERR" rc=0
  put_dir "$(dirname "$f")" || rc=$?
  [ "$rc" != 2 ] || return 2
  PUT_ERR="$err"
  return 1
}
put_dir() {
  local p="$1"
  PUT_PATH=""; PUT_ERR=""
  PUT_ERR="$(LC_ALL=C mkdir -p "$1" 2>&1)" && return 0
  while [ -n "$p" ] && [ "$p" != / ] && [ "$p" != . ]; do
    if [ -L "$p" ] || [ -e "$p" ]; then
      [ -d "$p" ] || { PUT_PATH="$p"; return 2; }
      break
    fi
    p="$(dirname "$p")"
  done
  return 1
}
put_failed() {
  if [ "$1" = 2 ]; then
    echo "$PUT_PATH is in the way, and no deploy or upgrade made it. Move it away, then try again. Nothing was changed."
    exit 2
  fi
  [ -z "$PUT_ERR" ] || printf '%s\n' "$PUT_ERR" >&2
  echo "$2"
  machine_short
}
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
  LOCK_ERR=""
  if ! LOCK_ERR="$(LC_ALL=C mkdir "$LOCK_PATH" 2>&1)"; then
    { [ ! -e "$LOCK_PATH" ] && [ ! -L "$LOCK_PATH" ]; } || return 1
    LOCK_ERR="$(LC_ALL=C mkdir "$LOCK_PATH" 2>&1)" || { { [ ! -e "$LOCK_PATH" ] && [ ! -L "$LOCK_PATH" ]; } || return 1; return 2; }
  fi
  LOCK="$LOCK_PATH"
  if LOCK_ERR="$( { export LC_ALL=C; printf '%s\n' "$ME" > "$LOCK_PATH/owner.$$" && mv -f "$LOCK_PATH/owner.$$" "$LOCK_PATH/owner"; } 2>&1 )"; then
    # A step log beside the lock is a run's of this install that held it, and
    # one left now is a killed run's (fifth review).
    rm -f "${LOCK_PATH%.lock.d}".step.* 2>/dev/null || true
    return 0
  fi
  # Holderless and under an hour old, no other run clears it: it is still this one's to remove.
  rm -rf "$LOCK_PATH" || true; LOCK=""
  return 2
}
# As upgrade.sh: a lock it could not make or write its holder in is the
# machine's (5, with what mkdir or the write said), not another deploy; and
# something not a folder in its place (a file, a symlink, dangling or not) is
# named.
lock_short() {
  [ -z "$LOCK_ERR" ] || printf '%s\n' "$LOCK_ERR" >&2
  echo "Could not take the upgrade lock $LOCK_PATH (above), so nothing was changed. Check that $(dirname "$LOCK_PATH") is a folder this user can write in, on a disk with room, then try again."
  machine_short
}
lock_in_way() {
  [ "$LOCK_RC" != 0 ] && { [ -L "$LOCK_PATH" ] || { [ -e "$LOCK_PATH" ] && [ ! -d "$LOCK_PATH" ]; }; } || return 0
  echo "$LOCK_PATH is in the way of the upgrade lock: it is not a folder, and no deploy or upgrade made it. Remove it (rm \"$LOCK_PATH\"), then try again."
  exit 2
}

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
# pins-recorded: upgrade.sh reads this record too, and a deploy pins nothing, so a
# version in this install's channel file is the person's own (upgrade.sh, HB-0428).
# Written before anything moves, so a disk too full for it changes nothing.
PRC=0; put_line "$FROM_FILE" "from $CUR" "to $TAG" pins-recorded || PRC=$?
[ "$PRC" = 0 ] || put_failed "$PRC" "Could not write $FROM_FILE (a full disk, or no permission there?), so nothing was changed. Free some space, then try again."
CHANGING=1
if [ -d node_modules ]; then mv node_modules node_modules.prev; fi; ASIDE=1
# A step that failed puts the old release back (UNDO): 5 when the disk is why
# (its words, or next to no room left) or a permission or read-only disk (its
# words, the path named: tenth review), judged before the rollback frees what
# the step wrote; else 3; and 3, said, when the rollback did not work either.
# As upgrade.sh's. change_failed UNDO WHAT [LINE…]
change_failed() {
  local undo_with="$1" what="$2" short=0 free
  shift 2
  step_short "$DIR" && short=1
  free="$(free_mb "$DIR")"
  [ "$#" = 0 ] || printf '%s\n' "$@"
  CHANGING=0
  # Not put back: the tree may be part-way between the two, which no wait
  # mends. Said so, with what to run, never "the disk" alone (eighth review).
  if ! "$undo_with"; then
    echo "Putting ${CUR:-the previous release} back did not work either (above), so $DIR may be part-way between ${CUR:-the previous release} and $TARGET."
    if [ "$short" = 1 ] && [ "$SHORT_WHY" = denied ]; then echo "This user could not write ${SHORT_PATH:-what it needed} (above: no permission there, or a read-only disk): fix that first."
    elif [ "$short" = 1 ]; then echo "The disk holding $DIR is full${free:+ ($free MB free)}: free about 1 GB first."; fi
    echo "Then run $REDO: it puts ${CUR:-the previous release} back first, from its record."
    exit 3
  fi
  if [ "$short" = 1 ] && [ "$SHORT_WHY" = denied ]; then
    echo "This user could not write ${SHORT_PATH:-what it needed} (above: no permission there, or a read-only disk), so $TARGET could not be $what. Fix that, then try again."
    machine_short
  elif [ "$short" = 1 ]; then
    echo "The disk holding $DIR is full${free:+ ($free MB free)}, so $TARGET could not be $what. Free about 1 GB, then try again."
    machine_short
  fi
  exit 3
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
# Each request has its own deadline, and the wait a total one: a listener that
# took the connection and never answered held one curl with no end, the
# rollback never came, and the upgrade lock stayed held (HB-0553).
DEADLINE=$((SECONDS + 90))
for i in $(seq 1 45); do
  GOT="$(curl -sk --connect-timeout 3 --max-time 10 "$URL" 2>/dev/null | grep -oE 'HATCHABOT_VERSION="[^"]+"' | sed -n 1p | cut -d'"' -f2 || true)"
  # The record goes first: left behind beside a half-removed node_modules.prev,
  # the next deploy moved that in over the release now serving.
  [ "$GOT" = "$WANT" ] && { CHANGING=0; SERVING=1; rm -f "$FROM_FILE"; echo "Serving $GOT."; rm -rf node_modules.prev || true; exit 0; }
  [ "$SECONDS" -lt "$DEADLINE" ] || break
  sleep 2
done
echo "Service restarted but is not serving $WANT — check: journalctl --user -u $SVC -n 50"
CHANGING=0; ROLLED_BACK=1; rollback || true; exit 1
