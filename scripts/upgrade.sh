#!/usr/bin/env bash
# Upgrade THIS machine's Hatchabot to the newest release on its channel.
#
#   hatchabot upgrade              # along the channel it was installed on (stable by default)
#   hatchabot upgrade beta         # switch channel (stable | beta | latest) and upgrade
#   hatchabot upgrade v2.31.3      # exactly that release — also how you roll back
#
# Same resolution as the installer: stable and beta are named in channels.json
# on main, latest is the newest tag. A channel only ever moves forward; naming a
# version is how to go back. If the new release does not come up, the previous
# one is restored.
#
# Exit codes (follow-channel.sh reads them): 0 upgraded, or nothing to do;
# 1 the new release did not come up and the previous one is back — the ONLY
# code that means "this release is bad, do not retry it"; 2 refused (local
# changes, no such channel or release); 3 did not complete (no network, an
# install that failed) with the previous release back as it was — try again;
# 4 another upgrade is running; 5 this machine had no room (a full disk) or no
# permission to write what the upgrade needs, with the previous release back
# as it was — try again, but it says nothing about the release (HB-0470).
set -euo pipefail
[ -x "$(dirname "$0")/../.node/bin/node" ] && PATH="$(cd "$(dirname "$0")/.." && pwd)/.node/bin:$PATH" && export PATH  # a bundle install's own Node (install.sh)
cd "$(dirname "$0")/.."
DIR="$PWD"

# Checking out a release replaces this file while bash is still reading it.
if [ -z "${HATCHABOT_UPGRADE_COPY:-}" ]; then
  # Its own message and exit 5: under set -e a full temp folder ended this with
  # exit 1, which the channel timer reads as "this release is bad" (HB-0438),
  # and with 3 a disk that stayed full set the release aside (HB-0470).
  tmp="$(mktemp)" && cp "$0" "$tmp" || { echo "Could not make a temporary copy of this script (a full disk?): nothing was changed. Free some space, then try again."; exit 5; }
  HATCHABOT_UPGRADE_COPY="$tmp" HATCHABOT_UPGRADE_DIR="$DIR" exec bash "$tmp" "$@"
fi
DIR="$HATCHABOT_UPGRADE_DIR"; cd "$DIR"

# Whatever ends this script ends here. A failure the script did not plan for
# (set -e after node_modules was moved aside, a failed mv in the bundle swap)
# used to leave a half-changed tree and exit 1 — which follow-channel.sh reads
# as "the release did not start", so it never tried that release again
# (review, 2026-10-09). Now the previous release is put back, and only an
# explicit rollback says 1.
ROLLED_BACK=0   # 1 once the new release was tried and did not come up
CHANGING=0      # 1 while the tree is part-way between two releases
RESTARTED=0     # 1 once the service was restarted onto the new release
ASIDE=0         # 1 once a git install's node_modules was moved aside
SERVING=0       # 1 once the new release is up: only tidying is left
DISK=0          # 1 once this run found the machine short of room or permission (machine_short)
LOCK=""; STAGE=""; STAGE_FREED=0; STEP_LOG=""; STEP_SAID=""
PIN_ON=""       # the pin this run answers for, its own or one a killed run left; PRE_*: what it replaced
PIN_RECORD=""; PRE_CHANNEL=""; PRE_USER_CHANNEL=""
undo() { :; }   # set below, per kind of install
REDO="hatchabot upgrade"   # what a person runs when the rollback did not work (change_failed)
finish() {
  local rc=$?
  set +e
  if [ "$rc" != 0 ] && [ "$CHANGING" = 1 ]; then
    CHANGING=0; rc=3; echo "The upgrade stopped part-way — putting ${CUR:-the previous release} back."; undo
  fi
  # Stopped once the new release was up (removing what it replaced, fetching
  # the runtime image): it is upgraded, not a failure to try again (HB-0266).
  # What was half removed goes with the next upgrade.
  if [ "$SERVING" = 1 ]; then rm -f "$SWAPPING" "$FROM_FILE"; rc=0; fi
  # A pin on a release this run did not end up on would hold the machine at one
  # it is not running, with the timer quiet and the public address's safeguard off
  # (HB-0428), so it goes back to what it replaced. Unless a channel was named since.
  if [ -n "$PIN_ON" ]; then
    if [ "$rc" != 0 ] && [ "$(remembered_channel)" = "$PIN_ON" ]; then unpin; fi
    rm -f "$PIN_RECORD" "$PIN_RECORD.tmp"
  fi
  # Only its holder lets it go: a lock cleared and taken by another run is theirs.
  [ -z "$LOCK" ] || [ "$(cat "$LOCK/owner" 2>/dev/null)" != "$ME" ] || rm -rf "$LOCK"
  rm -f "$HATCHABOT_UPGRADE_COPY"; [ -z "$STAGE" ] || rm -rf "$STAGE"; [ -z "$STEP_LOG" ] || rm -f "$STEP_LOG"
  # 5 only where this run found the disk or a permission (machine_short): under
  # set -e a command that exits 5 for its own reasons (curl 5, a node fatal
  # error) read as "the disk", which the timer retries for ever (review of HB-0470).
  case "$rc" in 0|2|3|4) ;; 5) [ "$DISK" = 1 ] || rc=3 ;; 1) [ "$ROLLED_BACK" = 1 ] || rc=3 ;; *) rc=3 ;; esac
  exit "$rc"
}
trap finish EXIT
# Stopped by a signal (Ctrl-C, `systemctl stop`, a closed terminal), bash
# ended without running finish: an upgrade cut off in `npm ci` left the tree
# on the new release with half its dependencies, and the next run said
# "Already on" it (HB-0043). Ended through exit, finish puts the old one back.
trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP

# The machine, said as the machine: exit 5, which the channel timer never counts
# against the release (HB-0470). The only way this run exits 5 (finish).
# deploy-release.sh keeps copies of these (machine_short, free_mb, disk_words,
# said_kind, said_path, own_place, disk_short, step_tee, step_tail, run_step, step_short, put_rec,
# change_failed), of the record writers (link_end, put_line, put_dir,
# put_failed) and of the lock's (take_lock, lock_short, lock_in_way), not a
# file both source: each runs from
# a temporary copy while scripts/ changes under it, and a sourced file missing
# there would stop it before it could put the release back.
# test/nightScripts.test.ts holds them equal (fifth and eighth reviews).
machine_short() { DISK=1; exit 5; }
# MB free on the disk holding a path ('' when df cannot say).
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
# permission, a read-only disk: this machine's too, 5, as the header says;
# tenth review), "own" (words of another failure), or nothing (it said
# nothing). said_kind TEXT
# The words, not the code: the disk's as disk_words reads them. A write that came
# up short ("unable to write", "write error", "short write") is the disk too,
# unless it says it was a permission, a read-only disk (denied) or a closed
# pipe (eighth review). An ssh key a server turned away is not a permission here,
# nor is a file it could not run (dash's "sh: 1: …: Permission denied", npm's
# "code 126", Node's "spawn … EACCES", bash's "line N: FILE: Permission
# denied" for a file of the release's without its execute bit, and exit 126
# in run_step): that is the release's own, 3. Denied is a write: EACCES or EROFS from open, mkdir,
# rename, write, cp or mv (eleventh review).
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
# put_rec FILE '>'|'>>' LINE…: a record of the change written or added to, in
# English and as a step (run_step), so a write that fails is judged like a
# move: a full disk said 3 there, and counted against the release (fifth review).
put_rec() {
  local LC_ALL=C f="$1" how="$2"
  shift 2
  if [ "$how" = '>' ]; then printf '%s\n' "$@" > "$f"; else printf '%s\n' "$@" >> "$f"; fi
}
# change_failed UNDO WHAT [LINE…]: a step of the change failed (a move of the
# swap, a record, the checkout, the install). Judged first, by its words
# (STEP_LOG) or the room left, before UNDO frees what it wrote; then UNDO
# (the install kind's `undo`, or `:` with nothing changed yet), and said. 5
# for the disk or a permission, the machine's, the path named when the words
# name one (tenth review); else 3. One for the swap and the checkout,
# which each had their own (fifth review). An UNDO that did not work is
# said, with what to run (REDO), and is 3: it said the disk, and that the old
# release was back (eighth review).
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

# The channel chosen last is this install's own, in data/channel (HB-0235):
# the one file in ~/.config/hatchabot was every install's of the user's, so
# `hatchabot upgrade beta` in a test clone moved the production install's
# timer onto beta. That file is still read when this install has none of its
# own, and still written for a release from before v2.169.0, the only one it
# reads (remember_channel). install.sh and follow-channel.sh do the same.
CHANNEL_FILE="$DIR/data/channel"; USER_CHANNEL_FILE="$HOME/.config/hatchabot/channel"; PER_INSTALL_FROM=v2.169.0
remembered_channel() { local f; for f in "$CHANNEL_FILE" "$USER_CHANNEL_FILE"; do [ -f "$f" ] && { tr -d '[:space:]' < "$f"; return 0; }; done; return 0; }
file_channel() { if [ -f "$1" ]; then tr -d '[:space:]' < "$1"; fi; }
ARG="${1:-}"
CHANNEL="$ARG"
[ -n "$CHANNEL" ] || CHANNEL="$(remembered_channel)"
CHANNEL="${CHANNEL:-stable}"

# A bundle install (install.sh) has no clone: it upgrades by swapping in the
# next release's bundle (below), and resolves channels without git.
# (Or a swap that was cut off, which may have moved BUNDLE.json aside: below.)
BUNDLED=0; { [ -f BUNDLE.json ] || [ -f .swapping ]; } && [ ! -d .git ] && BUNDLED=1
# The newer of two versions. `sort -V` alone ranks v2.35.0-beta.1 ABOVE v2.35.0,
# which stranded a beta tester on the prerelease; "~" sorts below everything.
vernewer() { printf '%s\n%s\n' "$1" "$2" | sed 's/-/~/' | sort -V | tail -1 | sed 's/~/-/'; }

# A channel asked for by name is remembered, so the next plain upgrade follows it
# — even when there is nothing to install today. Not when the channel timer
# asks (follow-channel.sh): it named its own channel, and writing that undid a
# `hatchabot upgrade beta` within ten minutes (review, 2026-10-09).
# remember_channel VALUE [RELEASE]: VALUE for this install. RELEASE, the one
# it will run, from before v2.169.0 reads only the user's file: it goes there
# (and this install's own goes, so the two cannot disagree once it is back).
# Each step only once the one before it worked, and non-zero if any failed:
# called under `||`, set -e is off in here, and a failed write of the user's
# file was passed over, this install's own deleted, and the pin said made
# (second review of HB-0470).
# put_line FILE LINE…: FILE holds the LINEs, written beside it and renamed over it,
# so a full disk leaves the old value whole, not an empty file (fourth review).
# A FILE that is a symlink to a file (stow, a dotfiles folder) is written
# through: the file it names is replaced beside itself, and the link stays
# (sixth review). 0 written; 2 something not a file is in the way (PUT_PATH:
# a folder, which a rename would put it inside; a link to no file, dangling or
# to a folder; a file where a folder above it goes); 1 the write failed, its
# words in PUT_ERR.
PUT_PATH=""; PUT_ERR=""
# The path a symlink comes to, followed link by link (`readlink -f` is not on
# older macOS). Non-zero for a loop of links.
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
# put_dir DIR: makes the folder DIR, with put_line's codes: 2 when something
# that is not a folder is in the way (PUT_PATH: DIR itself, or a folder above
# it); 1 mkdir failed, its words in PUT_ERR (seventh review: it was always
# the disk).
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
# put_failed RC MESSAGE: after a put_line, put_dir (or remember_channel) that
# failed with RC. In the way, named and refused (2), as lock_in_way (fifth
# review: a folder where the file goes read as a full disk). Anything else
# (no room, no permission, a read-only disk) is the machine's, 5, as the
# header says: these are this install's own files, never the release's, and
# 3 counted against it (ninth review).
put_failed() {
  if [ "$1" = 2 ]; then
    echo "$PUT_PATH is in the way, and no deploy or upgrade made it. Move it away, then try again. Nothing was changed."
    exit 2
  fi
  [ -z "$PUT_ERR" ] || printf '%s\n' "$PUT_ERR" >&2
  echo "$2"
  machine_short
}
remember_channel() {
  if [ -n "${2:-}" ] && [ "$(vernewer "$2" "$PER_INSTALL_FROM")" != "$2" ]; then
    put_line "$USER_CHANNEL_FILE" "$1" && rm -f "$CHANNEL_FILE"
  else
    put_line "$CHANNEL_FILE" "$1"
  fi
}
if [ "${HATCHABOT_UPGRADE_BY_TIMER:-}" != 1 ]; then
case "$ARG" in stable|beta|latest) PRC=0; remember_channel "$ARG" || PRC=$?; [ "$PRC" = 0 ] || put_failed "$PRC" "Could not write which channel this machine follows (a full disk, or no permission?), so nothing was changed. Free some space, then try again." ;; esac
fi
# A version named by hand is a pin: the channel timer leaves this machine
# alone until a channel is named again (a rollback used to be undone within
# ten minutes; use-case audit, 2026-09-27). Written once that release is known
# to be there, under the lock (below), not here: a mistyped version, a dirty
# tree or a busy lock left a pin on a release never installed, with the timer
# quiet for good and the public address's safeguard off (HB-0428).
# What it replaces is written down first, beside the lock (PIN_RECORD): SIGKILL
# or a power cut runs no finish, and the next run, the timer's as a rule, has to
# know where to go back to if this release does not end up installed. A run that
# took over a killed run's pin (below) goes back to what that pin replaced.
pin_named() {
  [ "${HATCHABOT_UPGRADE_BY_TIMER:-}" != 1 ] || return 0
  case "$ARG" in v[0-9]*) ;; *) return 0 ;; esac
  if [ -z "$PIN_ON" ]; then
    PRE_CHANNEL="$(file_channel "$CHANNEL_FILE")"; PRE_USER_CHANNEL="$(file_channel "$USER_CHANNEL_FILE")"
  fi
  # This machine's disk, not the release's: exit 5 (review of HB-0470); something
  # in the way of the record, named (2); else 3 (put_failed).
  local prc=0
  put_line "$PIN_RECORD" "pin $ARG" "channel $PRE_CHANNEL" "user $PRE_USER_CHANNEL" || prc=$?
  [ "$prc" = 0 ] || put_failed "$prc" "Could not write $PIN_RECORD (a full disk, or no permission there?), so nothing was changed. Free some space, then try again."
  PIN_ON="$ARG"
  remember_channel "$ARG" "$ARG" || prc=$?
  [ "$prc" = 0 ] || put_failed "$prc" "Could not write which release this machine is pinned to (a full disk, or no permission?), so nothing was changed. Free some space, then try again."
  echo "Pinned to $ARG — automatic upgrades pause here. Follow a channel again with: hatchabot upgrade stable"
}
unpin() {
  local f v
  for f in CHANNEL_FILE USER_CHANNEL_FILE; do
    if [ "$f" = CHANNEL_FILE ]; then v="$PRE_CHANNEL"; else v="$PRE_USER_CHANNEL"; fi
    if [ -n "$v" ]; then put_line "${!f}" "$v" || echo "Could not put ${!f} back to $v (${PUT_ERR:-$PUT_PATH is in the way}): it may still name $PIN_ON."; else rm -f "${!f}"; fi
  done
  echo "Not pinned to $PIN_ON: the upgrade did not finish, so this machine goes on as it was."
}

# One upgrade at a time: the channel timer and a hand-run upgrade used to race
# each other's node_modules.prev (30th audit). The lock lives outside the tree
# (an untracked file here would read as a local change next time).
# The lock is a directory (mkdir is atomic everywhere; macOS has no flock — the
# first version of this refused every Mac upgrade, 2026-09-27). It is in this
# user's own state folder, not /tmp: on a shared host anyone could make the
# /tmp name first and stop every upgrade (review, 2026-10-09).
# Its holder is written in it (pid and start time: a pid reused since is not
# the holder), and only a holder that is gone makes it a leftover. Age alone
# used to: a slow download past an hour lost its lock to the next run, and two
# upgrades swapped the tree at once (#226). A lock with no holder written
# (from an older release) is still a leftover after an hour. Leftovers are
# cleared under a second lock, judged again once it is held, so two runs
# clearing one leftover cannot remove the lock the first then took.
# deploy-release.sh takes the same lock the same way.
LOCKS="${XDG_STATE_HOME:-$HOME/.local/state}/hatchabot"
PRC=0; put_dir "$LOCKS" || PRC=$?
[ "$PRC" = 0 ] || put_failed "$PRC" "Could not make $LOCKS, where upgrades keep their lock (a full disk, or no permission there?): nothing was changed. Free some space or fix its permissions, then try again."
LOCK_PATH="$LOCKS/upgrade-$(printf %s "$DIR" | cksum | cut -d' ' -f1).lock.d"
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
# take_lock: 0 taken; 1 another run holds it (or a file is in its way); 2 the
# machine could not make it or write its holder (a full disk, no permission).
# A holder that could not be written left the lock behind, holderless, and
# this run and every one for the next hour said "another upgrade" (4) of a disk
# that was full (second review of HB-0470): the lock is let go here, and the
# run ends as the machine's (5). A mkdir that failed on a lock let go just
# after is tried once more, not taken for the disk (third review).
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
# A lock it could not make, or write its holder in (take_lock's 2): what mkdir
# or the write said (LOCK_ERR) is shown, the folder named. No room or no
# permission there, it is the machine's, 5, never the release's (ninth review).
lock_short() {
  [ -z "$LOCK_ERR" ] || printf '%s\n' "$LOCK_ERR" >&2
  echo "Could not take the upgrade lock $LOCK_PATH (above), so nothing was changed. Check that $(dirname "$LOCK_PATH") is a folder this user can write in, on a disk with room, then try again."
  machine_short
}
# Something not a folder where the lock goes (a file, a symlink, dangling or
# not): no run holds it, and none could take it, so every run said "another
# upgrade", or the disk (third and fourth reviews). Named, refused.
lock_in_way() {
  [ "$LOCK_RC" != 0 ] && { [ -L "$LOCK_PATH" ] || { [ -e "$LOCK_PATH" ] && [ ! -d "$LOCK_PATH" ]; }; } || return 0
  echo "$LOCK_PATH is in the way of the upgrade lock: it is not a folder, and no deploy or upgrade made it. Remove it (rm \"$LOCK_PATH\"), then try again."
  exit 2
}
# release-target.sh: 1 = no such channel or release (it says which), anything
# else = it could not find out (no network, an answer that is not a channels
# file). Neither is the release failing: `|| exit 1` here once got releases
# that were never tried blacklisted by the channel timer (review, 2026-10-09).
# The channel timer (follow-channel.sh) resolved the channel already and
# remembers a failure by that release: it passes it, so the release tried is
# the one it records (audit #042).
# HATCHABOT_UPGRADE_REPAIR_ONLY=1: the channel timer could not find the release
# (no network), but an upgrade cut off part-way is here to repair. That needs
# nothing from the network, so it is done, and nothing else (HB-0547).
# Looked for before the lock, a lookup that failed may be the tree changing
# under an upgrade that holds it (a bundle swap moves scripts/): that is 4, as
# taking the lock first said.
REPAIR_ONLY=0; [ "${HATCHABOT_UPGRADE_REPAIR_ONLY:-}" != 1 ] || REPAIR_ONLY=1
TARGET=""; LOOKED=0
find_target() {
  local trc=0
  if [ "$REPAIR_ONLY" = 1 ]; then
    TARGET=""
  elif [ -n "${HATCHABOT_UPGRADE_TARGET:-}" ]; then
    case "$HATCHABOT_UPGRADE_TARGET" in v[0-9]*) TARGET="$HATCHABOT_UPGRADE_TARGET" ;; *) echo "Not a release: $HATCHABOT_UPGRADE_TARGET"; exit 2 ;; esac
  else
    TARGET="$("$DIR/scripts/release-target.sh" "$CHANNEL")" || trc=$?
    [ "$trc" != 1 ] || exit 2
    if [ "$trc" != 0 ]; then
      if [ -z "$LOCK" ] && [ -d "$LOCK_PATH" ] && ! lock_left_over; then echo "Another upgrade of $DIR is running (lock $LOCK_PATH)."; exit 4; fi
      echo "Could not find which release $CHANNEL names now — try again later."; exit 3
    fi
  fi
  [ "$REPAIR_ONLY" = 1 ] || [ -n "$TARGET" ] || { echo "Could not find which release $CHANNEL names (no network to github.com?)."; exit 3; }
  LOOKED=1
}
# Before the lock, unless scripts/ is not here to look with: a rollback cut
# between its renames (below) is repaired first, under the lock.
if [ -e "$DIR/scripts/release-target.sh" ] || [ "$REPAIR_ONLY" = 1 ] || [ -n "${HATCHABOT_UPGRADE_TARGET:-}" ]; then find_target; fi

LOCK_RC=0; take_lock || LOCK_RC=$?
[ "$LOCK_RC" != 2 ] || lock_short
if [ "$LOCK_RC" != 0 ]; then
  # Clearing takes milliseconds: a clearing lock this old is a crash's.
  [ -z "$(find "$LOCK_PATH.clearing" -maxdepth 0 -mmin +10 2>/dev/null)" ] || rmdir "$LOCK_PATH.clearing" 2>/dev/null || true
  if [ -d "$LOCK_PATH" ] && lock_left_over && mkdir "$LOCK_PATH.clearing" 2>/dev/null; then
    if lock_left_over; then rm -rf "$LOCK_PATH"; fi
    rmdir "$LOCK_PATH.clearing" 2>/dev/null || true
  fi
  LOCK_RC=0; take_lock || LOCK_RC=$?
  [ "$LOCK_RC" != 2 ] || lock_short
  lock_in_way
  [ "$LOCK_RC" = 0 ] || { echo "Another upgrade of $DIR is running (lock $LOCK_PATH)."; exit 4; }
fi

# A rollback cut between its last two renames of scripts/ (restore_prev,
# below) left none here, and the old one beside it: in it goes, under the lock
# (a held lock leaves it to its holder) and before anything reads scripts/.
# No timer can run then; the new release's upgrade.sh, held in
# .rollback-aside, run by hand repairs it (fourth and fifth reviews of HB-0487).
if [ "$BUNDLED" = 1 ] && [ ! -e scripts ] && [ ! -L scripts ] && [ -d .rollback-scripts ] && [ ! -L .rollback-scripts ]; then
  mv .rollback-scripts scripts || { echo "Could not move $DIR/.rollback-scripts back to scripts/ (above)."; exit 3; }
fi

# Which release CHANNEL names was looked for before the lock (above): with
# the network down the lookup can take minutes, and it held the lock all that
# while, so a channel tick then said "another upgrade" (4) and did nothing
# (tenth review). Here only when scripts/ had to be put back first.
if [ "$LOOKED" = 0 ]; then find_target; fi

# A bundle swap moves the old release's files into .prev-release, then the
# new one's in, one by one. Cut off part-way (SIGKILL, a power cut), it left
# the tree half old, half new; BUNDLE.json was often the new one already, so
# every later run said "Already on vNEW" and the install stayed broken
# (HB-0049). The swap writes .swapping before its first move, and names each
# file in it before moving that file in: the next run puts the previous
# release back first, then upgrades as usual.
SWAPPING="$DIR/.swapping"; PREV="$DIR/.prev-release"
FROM_FILE="${LOCK_PATH%.lock.d}.from"   # a git install's, described below
# A pin a killed run left: `pin <release>`, `channel <what data/channel held>`,
# `user <what the user's file held>`. This run now sees it through, and if that
# release does not end up installed, finish puts those back (HB-0428): until then
# the machine is held at a release it does not run, and the timer would have
# nothing more to do. A channel named since, or a kill before the pin was written:
# the record no longer means anything. An upgrade.sh from before the record left
# only the pin and the swap to repair, so what the pin replaced is not known: it
# comes off, which leaves the other file, then the timer's own channel.
# Only that one: every upgrade.sh that writes the record says so in the swap's or
# the checkout's own record (PINS_RECORDED), and writes the pin's record first. A
# version with no pin record beside one of those is the person's own: a pin
# completed earlier, or one a failed repair just put back while that repair is
# still owed. Read as a leftover, the next failed repair deleted it (HB-0428).
PIN_RECORD="${LOCK_PATH%.lock.d}.pin"; PINS_RECORDED="pins-recorded"
CUT_RECORD="$FROM_FILE"; [ "$BUNDLED" = 0 ] || CUT_RECORD="$SWAPPING"
if [ -f "$PIN_RECORD" ]; then
  LEFT_PIN="$(sed -n 's/^pin //p' "$PIN_RECORD" | sed -n 1p)"
  if [ -n "$LEFT_PIN" ] && [ "$(remembered_channel)" = "$LEFT_PIN" ]; then
    PRE_CHANNEL="$(sed -n 's/^channel //p' "$PIN_RECORD" | sed -n 1p)"
    PRE_USER_CHANNEL="$(sed -n 's/^user //p' "$PIN_RECORD" | sed -n 1p)"
    PIN_ON="$LEFT_PIN"
  else
    rm -f "$PIN_RECORD"
  fi
elif [ -f "$CUT_RECORD" ] && ! grep -qx "$PINS_RECORDED" "$CUT_RECORD"; then
  LEFT_PIN="$(remembered_channel)"
  case "$LEFT_PIN" in v[0-9]*)
    PRE_CHANNEL="$(file_channel "$CHANNEL_FILE")"; [ "$PRE_CHANNEL" != "$LEFT_PIN" ] || PRE_CHANNEL=""
    PRE_USER_CHANNEL="$(file_channel "$USER_CHANNEL_FILE")"; [ "$PRE_USER_CHANNEL" != "$LEFT_PIN" ] || PRE_USER_CHANNEL=""
    PIN_ON="$LEFT_PIN" ;;
  esac
fi
# A name a bundle's file list may not touch: a path, or what is this machine's.
not_ours() { case "$1" in ''|*/*|.|..|.env|data|.swapping|.swapping.tmp|.prev-release|.rollback-aside|.rollback-scripts) return 0 ;; esac; return 1; }
# Back to the release in .prev-release: the previous files moved back, then
# what else came in from the new bundle removed. Run again after a cut, it
# goes on: each file's `in` line is struck from .swapping before it moves
# back, so one already back is the old release's, never removed as the new
# one's. It was, and a rollback cut off after putting a file back deleted it
# for good (HB-0279). Struck, not marked: an upgrade.sh from before this
# reads only `in` lines, and scripts/ goes back first (cut off, the tree
# holds an upgrade.sh that goes on), so the old one may finish the job.
restore_prev() {
  # held: the new release's copy of a name, kept until the old one is in.
  local line f n src aside held="$DIR/.rollback-aside" beside="$DIR/.rollback-scripts" back='
' unstruck=0
  # Every move here goes onto a name that is not there: mv onto a folder puts
  # what moves inside it (HB-0071), and `mv -T`, which would refuse, is GNU's
  # alone. A held copy a failed rm left took the next name inside itself, and a
  # put-back nested scripts/scripts/ (review of HB-0487).
  gone() { [ ! -e "$1" ] && [ ! -L "$1" ]; }
  # The old scripts/ goes in through a name beside it (below). A cut with it
  # there: with no scripts/ here, it was cut between the last two renames, and
  # it goes in; else it goes back to .prev-release, and is put in again.
  if ! gone "$beside"; then
    if gone "$DIR/scripts"; then mv "$beside" "$DIR/scripts" || return 1
    elif gone "$PREV/scripts"; then mkdir -p "$PREV" && mv "$beside" "$PREV/scripts" || return 1
    else echo "$beside and $PREV/scripts are both there: which is the previous release's cannot be told. Remove the one that is not, then try again."; return 1
    fi
  fi
  rm -rf "$held"
  gone "$held" || { echo "Could not remove $held (above)."; return 1; }
  for f in "$PREV"/scripts "$PREV"/* "$PREV"/.[!.]*; do
    [ -e "$f" ] || continue
    n="${f##*/}"
    src="$f"
    # scripts/ is what the timer and the repair run: with a cut between moving
    # the new one aside and the old one in, there was none, and nothing could
    # put the release back. The old one is put beside it first, struck, and
    # then the two renames run back to back: the only moment with no scripts/
    # is between those two (no rename swaps two folders), and a cut anywhere
    # else is gone on from above (fourth review of HB-0487).
    if [ "$n" = scripts ] && ! gone "$DIR/scripts"; then
      mv "$f" "$beside" || return 1
      src="$beside"
    fi
    # One of that name here, the new one, would take the old one inside
    # itself, a directory in a directory (HB-0071). It goes aside, not away,
    # until the old one is in: removed first, a move that failed left the
    # install with no scripts/, so no upgrade.sh to repair it (HB-0487).
    # Struck before the old one goes in: struck after, a cut in between left
    # the old one listed as the new one's, for the old upgrade.sh to remove.
    aside=0
    if [ "$src" = "$f" ] && ! gone "$DIR/$n"; then
      mv "$DIR/$n" "$held" || return 1
      aside=1
    fi
    # A record that cannot be rewritten (the disk that filled) does not stop
    # the rollback: the moves are what count, and this run remembers what it
    # put back (twelfth review). It ended "did not work either", 3, with the
    # old release one rename from back.
    if [ -f "$SWAPPING" ] && grep -qxF "in $n" "$SWAPPING"; then
      if ! { { grep -vxF "in $n" "$SWAPPING" || [ $? = 1 ]; } > "$SWAPPING.tmp" && mv -f "$SWAPPING.tmp" "$SWAPPING"; } 2>/dev/null; then
        rm -f "$SWAPPING.tmp" 2>/dev/null || true
        unstruck=1
      fi
    fi
    if [ "$src" != "$f" ]; then
      mv "$DIR/$n" "$held" || { mv "$beside" "$f"; return 1; }
      aside=1
    fi
    if ! gone "$DIR/$n" || ! mv "$src" "$DIR/$n"; then
      [ "$aside" = 0 ] || ! gone "$DIR/$n" || mv "$held" "$DIR/$n"
      [ "$src" = "$f" ] || gone "$beside" || mv "$beside" "$f"
      return 1
    fi
    back="$back$n
"
    rm -rf "$held"
    gone "$held" || { echo "Could not remove $held (above)."; return 1; }
  done
  [ "$unstruck" = 0 ] || echo "Could not write $SWAPPING as the files went back (a full disk?): they are back all the same."
  # The new release's unpacked bundle, beside the install.
  STAGED="$(sed -n 's/^stage //p' "$SWAPPING" 2>/dev/null | sed -n 1p)"
  case "$STAGED" in "$(dirname "$DIR")"/.hatchabot-next-*) ;; *) STAGED="" ;; esac
  if [ -f "$SWAPPING" ]; then
    while IFS= read -r line; do
      case "$line" in "in "?*) f="${line#in }" ;; *) continue ;; esac
      # Put back just now, its line not struck: the old one's, kept.
      case "$back" in *"
$f
"*) continue ;; esac
      # The unpacked bundle gone, and not by this run: only a rollback of this
      # upgrade.sh's frees it first, and this one was cut off once it had put
      # files back whose lines it could not strike (a full disk). The one here
      # may be the old one put back: kept. Removed, the install lost a file of
      # the release it went back to (fourteenth review). One the new release
      # alone had is kept too, a leftover the next swap moves aside; the
      # record goes below, whole, so nothing is struck here.
      if [ -n "$STAGED" ] && [ "$STAGE_FREED" = 0 ] && [ ! -e "$STAGED" ] && [ ! -L "$STAGED" ]; then continue; fi
      # Still in the bundle, the new one never moved in: the one here is the
      # old one. An upgrade.sh from before v2.171.0 wrote `in` before moving
      # the old one aside, and a cut in between lost it (HB-0279).
      if [ -n "$STAGED" ] && { [ -e "$STAGED/hatchabot/$f" ] || [ -L "$STAGED/hatchabot/$f" ]; }; then continue; fi
      not_ours "$f" || rm -rf "${DIR:?}/$f"
    done < "$SWAPPING"
  fi
  rm -rf "$PREV"
  # The unpacked bundle goes with it.
  [ -z "$STAGED" ] || rm -rf "$STAGED"
  rm -f "$SWAPPING" "$SWAPPING.tmp"
}
if [ "$BUNDLED" = 1 ] && [ -f "$SWAPPING" ]; then
  echo "An upgrade of $DIR was cut off part-way — putting $(sed -n 's/^from //p' "$SWAPPING" | sed -n 1p) back first."
  WAS_RESTARTED=0; ! grep -qx restarted "$SWAPPING" || WAS_RESTARTED=1
  restore_prev || { echo "Could not put the previous release back (above): $PREV holds its files."; exit 3; }
  # The service was already restarted onto the new release: back onto this one.
  if [ "$WAS_RESTARTED" = 1 ]; then PATH="$DIR/.node/bin:$PATH" "$DIR/scripts/restart.sh" || true; fi
fi

RESTART="${HATCHABOT_RESTART_CMD:-./scripts/restart.sh}"   # overridable for tests only
# A git install's upgrade in progress, beside the lock (in the tree it would
# read as a local change): `from <release>`, then `restarted` once the service
# was restarted onto the new one. Left behind, the run was killed part-way
# (SIGKILL, a power cut): the checkout may be on the new release with half
# its dependencies installed, and the old ones in node_modules.prev. The next
# run puts the old release back first, then upgrades as usual (HB-0043).
# Every checkout under the record writes its holder there first, by the process
# that becomes git (pid and start time, as the lock's holder): a kill in the
# checkout leaves .git/index.lock, and every later upgrade failed on it.
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
    if [ -n "$start" ]; then [ "$start" != "$(proc_start "$pid")" ] || { echo "The checkout that upgrade started is still running (pid $pid) — try again once it ends."; return 1; }
    elif kill -0 "$pid" 2>/dev/null; then echo "The checkout that upgrade started is still running (pid $pid) — try again once it ends."; return 1; fi
  done < "$FROM_FILE"
  [ -e .git/index.lock ] || return 0
  local live
  if live="$(git_running_here)"; then
    if [ "$live" != unknown ]; then echo "$DIR/.git/index.lock is held by a git running there (pid $live), which this upgrade did not start — try again once it ends."; return 1; fi
    named=0
  fi
  if [ "$named" = 1 ] && [ ! "$FROM_FILE" -nt .git/index.lock ] && [ -n "$(find .git/index.lock -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
    echo "Removing the .git/index.lock the upgrade that was cut off left behind."
    rm -f .git/index.lock; return 0
  fi
  echo "$DIR/.git/index.lock is in the way, and nothing shows it is that upgrade's own (one a few minutes old may be: try again then). If no git is running there, remove it: rm $DIR/.git/index.lock"
  return 1
}
# Back to the release the record names. Forced, and through the new one first
# when the tree is part-way: a checkout cut off leaves HEAD and the index on the
# old one with files rewritten, which a plain checkout kept (mixed code, then
# refused as local changes for good). The upgrade started from a clean tree, and
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
if [ "$BUNDLED" = 0 ] && [ -f "$FROM_FILE" ]; then
  FROM="$(sed -n 's/^from //p' "$FROM_FILE" | sed -n 1p)"; TO="$(sed -n 's/^to //p' "$FROM_FILE" | sed -n 1p)"
  echo "An upgrade of $DIR was cut off part-way — putting ${FROM:-the previous release} back first."
  clear_own_index_lock || exit 3
  repair_tree || { echo "Could not check out ${FROM:-the previous release} (above): node_modules.prev holds its dependencies."; exit 3; }
  [ ! -d node_modules.prev ] || { rm -rf node_modules; mv node_modules.prev node_modules; }
  if grep -qx restarted "$FROM_FILE"; then $RESTART || true; fi
  rm -f "$FROM_FILE"
fi
# The repair alone: which release comes next needs the network. A pin a killed
# run left stays recorded for the next full run to see through.
if [ "$REPAIR_ONLY" = 1 ]; then
  PIN_ON=""
  echo "Which release $CHANNEL names is looked for again on the next try."
  exit 0
fi

# What this run follows, read again now the lock is held: the owner (or
# another upgrade) may have pinned a release or named another channel while
# it looked for the release or waited, and going on would undo that. Read
# again for a run that read it from this install's file (none named), for the
# channel timer, which names the channel it read before this ran, and for a
# channel named by hand, written before the lock (tenth and twelfth reviews).
# A version named by hand is the person's own, and stands. Not one of them
# (none at all, or not a channel), the timer follows its own: nothing to read.
# After the repairs above, which need no channel; a pin a killed run left
# stays recorded for the next run to see through.
case "$ARG" in ''|stable|beta|latest) RECHECK=1 ;; *) RECHECK=0 ;; esac
[ "${HATCHABOT_UPGRADE_BY_TIMER:-}" != 1 ] || RECHECK=1
if [ "$RECHECK" = 1 ]; then
  NOW="$(remembered_channel)"; [ -n "$NOW" ] || [ -n "$ARG" ] || NOW=stable
  case "$NOW" in stable|beta|latest|v[0-9]*) ;; *) NOW="" ;; esac
  if [ -n "$NOW" ] && [ "$NOW" != "$CHANNEL" ]; then
    # Left as it is, a pin a killed run left is the next run's to see to.
    PIN_ON=""
    # 4, as for a lock another holds: routine, so the timer touches nothing.
    # 0 read as an upgrade done, and the timer forgot the tries of a release
    # it never tried, and the release it had set aside (thirteenth review).
    if [ -z "$ARG" ] && [ "${HATCHABOT_UPGRADE_BY_TIMER:-}" != 1 ]; then
      echo "While this looked for the release $CHANNEL names, another upgrade set this machine to follow $NOW: nothing was changed. Run hatchabot upgrade again to follow $NOW."
    else
      echo "The channel changed while this waited: this machine now follows $NOW, not $CHANNEL, so nothing was changed."
    fi
    exit 4
  fi
fi

# What is installed, read only once the lock is held: read before it, a run
# that waited there while another upgrade moved this machine on judged by the
# release it no longer had, and a channel upgrade took the machine backwards
# (audit #035).
if [ "$BUNDLED" = 1 ]; then CUR="$(sed -nE 's/.*"tag":"([^"]+)".*/\1/p' BUNDLE.json)"
else CUR="$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)"; fi
# Killed once that release was up: it is what is installed, so the pin was kept.
if [ -n "$PIN_ON" ] && [ "$CUR" = "$PIN_ON" ]; then rm -f "$PIN_RECORD"; PIN_ON=""; PRE_CHANNEL=""; PRE_USER_CHANNEL=""; fi
if [ "$CUR" = "$TARGET" ]; then pin_named; echo "Already on $TARGET ($CHANNEL)."; exit 0; fi
case "$CHANNEL" in v[0-9]*) ;; *)
  # A channel never takes a machine backwards (this one may run ahead of it).
  if [[ "$CUR" == v* ]] && [ "$(vernewer "$CUR" "$TARGET")" = "$CUR" ]; then
    echo "On $CUR, which is newer than $CHANNEL ($TARGET). Nothing to do — name a version to go back."; exit 0
  fi ;;
esac
if [ "$BUNDLED" = 0 ] && [ -n "$(git --no-optional-locks status --porcelain)" ]; then
  echo "$DIR has local changes — an upgrade would overwrite them. Refusing:"; git --no-optional-locks status --porcelain | sed 's/^/    /'; exit 2
fi
# ensure-deps writes the stamp restart.sh checks: a bare `npm ci` left none,
# so restart.sh installed everything a second time, and a registry blip on
# that second run failed (and blacklisted) a good release (night review).
INSTALL="${HATCHABOT_INSTALL_CMD:-./scripts/ensure-deps.sh --quiet}"   # (likewise)
echo "Upgrading $CUR → $TARGET ($CHANNEL)…"
if [ "$BUNDLED" = 1 ]; then
  # The next release's bundle beside this install: downloaded, its hash checked,
  # unpacked and self-checked before anything here moves. Then the code is
  # swapped — only the bundle's own top-level files (its .bundle-files), so
  # .env, data/ and backups stay — with the old ones kept until the new
  # release is up; if it does not come up, they go back.
  PLATFORM="$(sed -nE 's/.*"platform":"([^"]+)".*/\1/p' BUNDLE.json)"
  NAME="hatchabot-$TARGET-$PLATFORM.tar.gz"
  BASE="${HATCHABOT_BUNDLE_BASE:-https://github.com/${HATCHABOT_SLUG:-hatchabot/hatchabot}/releases/download}"
  # The disk, said as the disk: it read as "no bundle yet", or as a release that
  # would not unpack, and the timer went on trying (HB-0438). A bundle's download
  # and unpacked copy sit beside the install until the swap.
  free_beside() { local mb; mb="$(free_mb "$(dirname "$DIR")")"; [ -z "$mb" ] || printf '%s MB free' "$mb"; }
  disk_full() {
    local free
    free="$(free_beside)"
    echo "The disk holding $(dirname "$DIR") is full${free:+ ($free)}, so the $TARGET bundle could not be written there: nothing was changed. Free about 1 GB, then try again."
    machine_short
  }
  # A folder that cannot be made there is not always the disk: a parent this user
  # cannot write fails the same way, and "full" sent people freeing space.
  no_stage() {
    local at free
    at="$(dirname "$DIR")"
    if [ ! -w "$at" ]; then
      echo "This user cannot write to $at, where the $TARGET bundle goes until the swap: nothing was changed. Fix that folder's permissions, then try again."
      machine_short
    fi
    free="$(free_beside)"
    echo "Could not make a folder in $at for the $TARGET bundle: no room or no permission there${free:+ ($free)}: nothing was changed. Free about 1 GB or fix that folder's permissions, then try again."
    machine_short
  }
  STAGE="$(mktemp -d "$(dirname "$DIR")/.hatchabot-next-XXXXXX")" || no_stage
  sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
  # What failed: this machine's disk (curl 23), no such file (a 404; 37 on a
  # file:// test bed), or the network. A version named by hand that is not there
  # is refused; a release a channel names may just not be published yet.
  DL_RC=0; DL_CODE="$(curl -sSL --retry 3 -o "$STAGE/$NAME" -w '%{http_code}' "$BASE/$TARGET/$NAME")" || DL_RC=$?
  case "$DL_RC:$DL_CODE" in
    0:200|0:000) ;;
    23:*) disk_full ;;
    0:404|37:*)
      case "$CHANNEL" in
        v[0-9]*) if [ "${HATCHABOT_UPGRADE_BY_TIMER:-}" != 1 ]; then echo "There is no release $TARGET for $PLATFORM: nothing was changed. Check the version, or follow a channel with: hatchabot upgrade stable"; exit 2; fi ;;
      esac
      echo "No bundle for $TARGET on $PLATFORM yet — try again later."; exit 3 ;;
    *) echo "Could not download the $TARGET bundle (curl $DL_RC, HTTP ${DL_CODE:-none}): nothing was changed — try again later."; exit 3 ;;
  esac
  # What the release vouches for (#38): the bundle's size and sha256 as its
  # release-manifest.json names them (scripts/release-manifest.sh, which also
  # keeps the manifest for the runtime image step below). A manifest that is
  # there but unreadable, or for another release, is refused — never passed
  # over for the weaker check. A release made before manifests (before
  # v2.159.0) has none: the .sha256 beside the bundle, as before (legacy).
  MRC=0; "$DIR/scripts/release-manifest.sh" asset "$TARGET" "$STAGE/$NAME" "$NAME" || MRC=$?
  case "$MRC" in
    0) ;;
    10)
      # Its own message: under pipefail a failed fetch here ended the script with curl's code and no word.
      WANT="$(curl -fsSL --retry 3 "$BASE/$TARGET/$NAME.sha256" 2>/dev/null | cut -d' ' -f1)" || { echo "Could not fetch the $TARGET bundle's checksum — try again later."; exit 3; }
      [ -n "$WANT" ] && [ "$WANT" = "$(sha "$STAGE/$NAME")" ] || { echo "The $TARGET bundle's checksum does not match — not installing it."; exit 3; } ;;
    3) echo "Could not fetch the $TARGET release's manifest to check its bundle — try again later."; exit 3 ;;
    *) echo "Not installing the $TARGET bundle: the release's manifest does not vouch for it (above). Staying on $CUR."; exit 3 ;;
  esac
  TAR_ERR=""
  # In English: its message is matched below.
  TAR_ERR="$(LC_ALL=C tar -xzf "$STAGE/$NAME" -C "$STAGE" 2>&1)" || {
    printf '%s\n' "$TAR_ERR" | tail -n 3
    case "$TAR_ERR" in *"No space left"*|*"Disk quota"*) disk_full ;; esac
    echo "Could not unpack the $TARGET bundle."; exit 3
  }
  NEW="$STAGE/hatchabot"
  ( cd "$NEW" && ./.node/bin/node -e 'new (require("better-sqlite3"))(":memory:").exec("SELECT 1")' ) >/dev/null 2>&1 || { echo "The $TARGET bundle does not run on this machine — staying on $CUR."; exit 3; }
  # A bundle from before the file list: what it holds is what it has.
  [ -f "$NEW/.bundle-files" ] || ( cd "$NEW" && ls -A > .bundle-files )
  [ -f .bundle-files ] || ls -A "$NEW" > .bundle-files.guess
  OLDLIST="$( [ -f .bundle-files ] && cat .bundle-files || cat .bundle-files.guess )"; rm -f .bundle-files.guess
  pin_named
  # Its own check below says what a failed rm left (set -e stopped here before).
  # A .rollback-scripts here is a leftover too: a swap cut off part-way was
  # put back above (restore_prev takes it in, or stops the run), so none is
  # under way now. Kept, a failed swap's rollback found it and the old
  # scripts/ in $PREV both, could not tell which was the old one, and left
  # the install part-way (eighth review). Under the lock, as all of this.
  rm -rf "$PREV" "$DIR/.rollback-aside" "$DIR/.rollback-scripts" || true
  # Never into what a failed rm left: moved onto, a folder takes the old one inside itself (HB-0071).
  for f in "$PREV" "$DIR/.rollback-aside" "$DIR/.rollback-scripts"; do
    { [ ! -e "$f" ] && [ ! -L "$f" ]; } || { echo "Could not remove $f (above), so nothing was changed. Remove it by hand, then try again."; exit 3; }
  done
  # A move or a record that failed for want of room is the machine's, 5, once
  # the swap is put back. It said 3, and the release counted as a bad one
  # (second and fifth reviews of HB-0470). Each step's errors kept to judge by
  # (run_step) beside the lock, in English.
  STEP_LOG="$(new_step_log)"
  LC_ALL=C run_step mkdir -p "$PREV" || change_failed : "swapped in" "Could not make $PREV (above), so nothing was changed."
  # What came in from the new bundle is written in .swapping (above), one name
  # a line, BEFORE it moves: a swap that stops part-way (a failed mv, or this
  # run killed) is undone from that and $PREV, not from a file list that may
  # itself be half moved.
  rollback_bundle() {
    echo "Rolling back to ${CUR}…"
    # The unpacked bundle first: on the disk that filled, the rollback needs
    # room for its record (twelfth review). Whatever of it did not move in is
    # not wanted, and this run wrote each `in` after moving the old one aside,
    # so restore_prev needs none of it to tell the two apart (HB-0279 is an
    # older upgrade.sh's order).
    [ -z "$STAGE" ] || rm -rf "$STAGE" || true
    STAGE_FREED=1   # restore_prev: what this run put back is what it knows of (back)
    restore_prev || return 1
    # The old release's restart, on its own Node — only when the service was
    # restarted onto the new one; otherwise the old release never stopped.
    if [ "$RESTARTED" = 1 ]; then PATH="$DIR/.node/bin:$PATH" "$DIR/scripts/restart.sh"; fi
    return 0
  }
  undo() { rollback_bundle; }
  # By its words too: a move across file systems that ran out of room removes
  # its part copy, and the space it took is free again (third review).
  swap_failed() { change_failed undo "swapped in" "$1" "The upgrade stopped part-way — putting $CUR back."; }
  CHANGING=1
  LC_ALL=C run_step put_rec "$SWAPPING" '>' "from $CUR" "to $TARGET" "stage $STAGE" "$PINS_RECORDED" || swap_failed "Could not write $SWAPPING (above)."
  # One name at a time, the old one aside and the new one straight in, and
  # scripts/ first: cut off, the tree is short at most the one name being
  # swapped, and holds the new upgrade.sh that repairs it. (Every old name
  # aside first left an install with no scripts at all until the end.)
  while IFS= read -r f; do
    [ -n "$f" ] && [ -e "$NEW/$f" ] || continue
    ! not_ours "$f" || continue
    # One already here goes aside, whether the old release listed it or not:
    # moved onto, a folder takes the new one inside itself (HB-0071). Aside
    # before it is written down: written first, a cut in between left the
    # old one here under a name the rollback removes (HB-0279).
    if [ -e "$DIR/$f" ]; then LC_ALL=C run_step mv "$DIR/$f" "$PREV/" || swap_failed "Could not move $DIR/$f aside."; fi
    LC_ALL=C run_step put_rec "$SWAPPING" '>>' "in $f" || swap_failed "Could not write $SWAPPING (above)."
    LC_ALL=C run_step mv "$NEW/$f" "$DIR/" || swap_failed "Could not move the new $f into $DIR."
  done < <(grep -x scripts "$NEW/.bundle-files" || true; grep -vx scripts "$NEW/.bundle-files" || true)
  # What the old release had and this one does not.
  while IFS= read -r f; do
    [ -n "$f" ] && [ -e "$DIR/$f" ] || continue
    ! not_ours "$f" || continue
    ! grep -qxF "in $f" "$SWAPPING" || continue
    LC_ALL=C run_step mv "$DIR/$f" "$PREV/" || swap_failed "Could not move $DIR/$f aside."
  done < <(printf '%s\n' "$OLDLIST")   # not <<<: bash 3.2 writes that to a temporary file, on the disk that may be full
  LC_ALL=C run_step put_rec "$SWAPPING" '>>' restarted || swap_failed "Could not write $SWAPPING (above)."
  RESTARTED=1
  PATH="$DIR/.node/bin:$PATH" "$DIR/scripts/restart.sh" || { CHANGING=0; ROLLED_BACK=1; rollback_bundle || true; exit 1; }
  CHANGING=0; SERVING=1
  rm -f "$SWAPPING"
  echo "Now on $TARGET."
  rm -rf "$PREV"
else
# `npm ci` deletes node_modules before installing, so a registry outage or a
# full disk used to leave the machine with NO dependencies (and the rollback's
# own npm ci failing under the same fault). Keep the working tree aside until
# the new one is in.
# Only once the working one was moved aside (ASIDE): stopped while a stale
# node_modules.prev was being removed, the rollback deleted the only working
# node_modules (HB-0266).
restore_deps() {
  if [ -d node_modules.prev ]; then rm -rf node_modules; mv node_modules.prev node_modules
  elif [ "$ASIDE" = 1 ]; then rm -rf node_modules; fi
  return 0
}
# The service is restarted only if it was restarted onto the new release: an
# install that failed left the old one running, and restarting it anyway
# restarted production every ten minutes while a release that cannot install
# kept failing (review, 2026-10-09).
# A checkout cut off part-way (a signal to the whole unit) leaves HEAD and
# the index on CUR with files rewritten, and a plain checkout of CUR kept
# them: mixed code, refused as local changes by every later upgrade (HB-0266).
# Then the new release first, and back, forced: tracked files only (the
# upgrade started from a clean tree), so .env and data/ stay.
back_to_cur() {
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse "$TARGET^{commit}")" ] && [ -n "$(git status --porcelain)" ]; then
    checkout_recorded --quiet --force "$TARGET" || return 1
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
  if [ "$RESTARTED" = 1 ]; then $RESTART; fi
}
undo() { rollback && rm -f "$FROM_FILE"; }
# An upgrade killed (or a power cut) right after moving node_modules aside
# left node_modules.prev as the only working copy. Put back first: deleted as
# a leftover, a failed install then had nothing to roll back to (audit #033).
[ -d node_modules ] || [ ! -d node_modules.prev ] || mv node_modules.prev node_modules
# A leftover, removed before the record is written: half removed under it,
# the next run's repair would move it in as the old release's.
rm -rf node_modules.prev
# Another git's lock, with nothing moved yet: the checkout would fail on it,
# and the rollback's too, with the dependencies aside (HB-0372).
[ ! -e .git/index.lock ] || { echo "$DIR/.git/index.lock is held, so nothing was changed — try again later. If no git is running there, remove it: rm $DIR/.git/index.lock"; exit 3; }
pin_named
# Written before anything moves, so a disk too full for it changes nothing;
# judged as any record is (put_failed: it was always the disk, seventh review).
PRC=0; put_line "$FROM_FILE" "from $CUR" "to $TARGET" "$PINS_RECORDED" || PRC=$?
[ "$PRC" = 0 ] || put_failed "$PRC" "Could not write $FROM_FILE (a full disk, or no permission there?), so nothing was changed. Free some space, then try again."
CHANGING=1
if [ -d node_modules ]; then mv node_modules node_modules.prev; fi; ASIDE=1
# The checkout or the install failed, and the old release goes back. Exit 3,
# usually something passing, unless the disk is what stopped it: a disk that
# filled here exited 3 too, and the timer set the release aside after 8 tries
# (review of HB-0470). Judged before the rollback frees what the step wrote
# (change_failed). The step's errors beside the lock, not in TMPDIR (fourth
# review) unless that folder takes no new file (new_step_log), and in English, so disk_short reads "No space left on device"
# whatever the locale.
STEP_LOG="$(new_step_log)"
LC_ALL=C run_step checkout_recorded --quiet "$TARGET" || change_failed undo "checked out" "The upgrade stopped part-way — putting $CUR back."
# The install's messages in English, which the step's words are judged by, and
# the rest of the locale the user's: LC_ALL=C over the whole install set every
# category, and builds lost the user's (fourteenth review). The user's LC_ALL,
# which would override LC_MESSAGES, becomes LANG, the fallback for the rest.
LANG="${LC_ALL:-${LANG-}}" LC_ALL= LC_MESSAGES=C run_step $INSTALL || change_failed undo installed
LC_ALL=C run_step put_rec "$FROM_FILE" '>>' restarted || change_failed undo started "Could not write $FROM_FILE (above)."
RESTARTED=1
$RESTART || { CHANGING=0; ROLLED_BACK=1; { rollback && rm -f "$FROM_FILE"; } || true; exit 1; }
CHANGING=0; SERVING=1
# The record first: left behind beside a half-removed node_modules.prev, the
# next run moved that in over the release now serving.
rm -f "$FROM_FILE"; echo "Now on $TARGET."; rm -rf node_modules.prev || true
fi

# The runtime image this release defaults to (OpenClaw X in the Dockerfile),
# if the machine does not have it yet. Until 2026-09-25 an upgrade left the
# image the install had first built — a MacBook on v2.80.0 still ran agents
# on OpenClaw 2026.7.1-2 two releases after 2026.9.6 became "the version
# every install gets". Best effort: a failed pull is a line here, never a
# failed upgrade, and the app's Settings → Images does the same on demand.
# On the daemon the service uses: the one .env names (a tenant's rootless daemon
# on a shared host), as setup-host.sh reads it; neither this shell nor the
# timer has .env, so the image was looked for and fetched on the default daemon,
# and the service's kept the old one (HB-0431). The last line wins, as systemd's
# EnvironmentFile reads it.
if [ "${HATCHABOT_UPGRADE_IMAGE:-1}" = 1 ] && command -v docker >/dev/null 2>&1; then
  if [ -f .env ] && grep -q '^DOCKER_HOST=' .env; then
    DH="$(sed -n 's/^DOCKER_HOST=//p' .env | tail -n1 | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e "s/^['\"]//" -e "s/['\"]$//")"
    if [ -n "$DH" ]; then export DOCKER_HOST="$DH"; else unset DOCKER_HOST; fi
  fi
  WANT="$(sed -n 's/^ARG OPENCLAW_VERSION=//p' docker/Dockerfile.runtime | sed -n 1p)"
  HAVE="$(docker image inspect hatchabot-runtime:latest --format '{{ index .Config.Labels "org.agentclaw.openclaw-version" }}' 2>/dev/null || true)"
  # Only upwards: a promoted candidate newer than the default stays.
  if [ -n "$WANT" ] && [ "$HAVE" != "$WANT" ] && { [ -z "$HAVE" ] || [ "$(printf '%s\n%s\n' "$HAVE" "$WANT" | sed 's/-/~/' | sort -V | sed -n 1p)" = "$(printf '%s' "$HAVE" | sed 's/-/~/')" ]; }; then
    echo "The runtime image here carries OpenClaw ${HAVE:-nothing}; this release's default is $WANT — fetching it (a few GB; agents move to it on their next rebuild)…"
    ./scripts/build-runtime-image.sh || echo "⚠ Could not fetch the $WANT image now — run ./scripts/build-runtime-image.sh later, or Settings → Images."
  fi
fi
