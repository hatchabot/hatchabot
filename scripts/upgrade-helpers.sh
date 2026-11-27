# The helpers upgrade.sh and deploy-release.sh share: how a failed step's
# words are read (the machine's disk or permissions, exit 5, never counted
# against the release; or the release's own, 3), the steps they are read
# from, the records and folders each keeps, the upgrade lock and the
# dependencies' lock, a release put back that did not come up, and a
# rollback written down for the next start. Definitions only, never run on
# its own: one copy, where deploy-release.sh kept its own of each and a test
# held the two equal, so a fix was made twice (HB-0636).
#
# Each script runs while the release under it changes (a checkout, a bundle
# swap), so this file is read once, at its start, before anything changes,
# and only the one that script was made with: its git blob id is
# HELPERS_BLOB in each (test/upgradeHelpers.test.ts holds them to this file,
# and says what to write when they are not).
#  - upgrade.sh puts it in the temporary copy it runs from, ahead of itself:
#    from the install's git by that id, so an upgrade cut off in its
#    checkout, with scripts/ part one release and part the other, still
#    finds the one it was made with; else from beside it, once git says it
#    is that file (git hash-object), or, with no git (a bundle install,
#    whose scripts/ moves whole), as it is.
#  - deploy-release.sh reads it from the production checkout's git by that
#    id: follow-latest.sh, every release's, runs a release's deploy script as
#    a temporary copy (git show TAG:scripts/deploy-release.sh, with nothing
#    beside it), and that tag carries this file. Run from a checkout (by
#    hand, hbt deploy), from beside it when that git does not have the id
#    yet, and only when it is that file (git hash-object).
# Found nowhere, either one stops before it changes anything, and says so
# (exit 2). The scripts of releases before this file keep their own copies,
# and never read it.
#
# They read the names both scripts give: the tree DIR, the release going in
# TARGET and the one it replaces CUR, what a person runs REDO, the run's own
# name RUN_NOUN, the lock LOCK_PATH (LOCK, LOCK_RC, ME, ME_UTC), the record
# FROM_FILE (FROM, TO), the dependencies' lock DEPS_LOCK (DEPS_LOCK_OLD,
# DEPS_ME, DEPS_WAIT, DEPS_HELD; ASIDE), the step's log STEP_LOG, and
# CHANGING and DISK for finish.

# ---- The machine's words, and the steps they are read from ----
# The machine, said as the machine: exit 5, which the timers never count
# against the release (HB-0470). Once a run is under way, the only way it
# exits 5 (its finish reads any other 5 as 3).
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
  case "$-" in
    *f*) glob=0 ;;
  esac
  set -f
  for line in $1; do
    case "$line" in
      *[![:space:]]*) said=1 ;;
      *) continue ;;
    esac
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
        case "$p" in
          /*) ;;
          *) p="$PWD/$p" ;;
        esac
        case "$p" in
          "${DIR:-$PWD}"/*) if [ -f "$p" ] && [ ! -x "$p" ] && [ -w "$p" ]; then run=1; else deny=1; fi ;;
          *) if own_place "$p"; then deny=1; else out=1; fi ;;
        esac ;;
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
  case "$p" in
    /*) ;;
    *) p="$PWD/$p" ;;
  esac
  for q in "${DIR:-$PWD}" "${XDG_STATE_HOME:-$HOME/.local/state}/hatchabot" "$HOME/.npm" "$HOME/.cache/node-gyp" "$HOME/.node-gyp" "${TMPDIR:-/tmp}"; do
    q="${q%/}"
    case "$p" in
      "$q"|"$q"/*) return 0 ;;
    esac
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
  case "$(said_kind "$kept")" in
    disk) return 20 ;;
    own) return 21 ;;
    denied) return 22 ;;
  esac
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
  case "$-" in
    *e*) e=1; set +e ;;
  esac
  { "$@" 2>&1 1>&3 | step_tee; st="${PIPESTATUS[0]} ${PIPESTATUS[1]}"; } 3>&1
  [ "$e" = 0 ] || set -e
  case "${st#* }" in
    20) STEP_SAID=disk ;;
    21) STEP_SAID=own ;;
    22) STEP_SAID=denied ;;
  esac
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
  [ -z "$free" ] || free=" ($free MB free)"
  [ "$#" = 0 ] || printf '%s\n' "$@"
  CHANGING=0
  # Not put back: the tree may be part-way between the two, which no wait
  # mends. Said so, with what to run, never "the disk" alone (eighth review).
  if ! "$undo_with"; then
    echo "Putting ${CUR:-the previous release} back did not work either (above), so $DIR may be part-way between ${CUR:-the previous release} and $TARGET."
    if [ "$short" = 1 ] && [ "$SHORT_WHY" = denied ]; then echo "This user could not write ${SHORT_PATH:-what it needed} (above: no permission there, or a read-only disk): fix that first."
    elif [ "$short" = 1 ]; then echo "The disk holding $DIR is full$free: free about 1 GB first."; fi
    echo "Then run $REDO: it puts ${CUR:-the previous release} back first, from its record."
    exit 3
  fi
  if [ "$short" = 1 ] && [ "$SHORT_WHY" = denied ]; then
    echo "This user could not write ${SHORT_PATH:-what it needed} (above: no permission there, or a read-only disk), so $TARGET could not be $what. Fix that, then try again."
    machine_short
  elif [ "$short" = 1 ]; then
    echo "The disk holding $DIR is full$free, so $TARGET could not be $what. Free about 1 GB, then try again."
    machine_short
  fi
  exit 3
}

# ---- Records and folders this install keeps ----
# The path a symlink comes to, followed link by link (`readlink -f` is not on
# older macOS). Non-zero for a loop of links.
link_end() {
  local p="$1" l n=0
  while [ -L "$p" ]; do
    [ "$n" -lt 40 ] || return 1
    l="$(readlink "$p")" || return 1
    case "$l" in
      /*) p="$l" ;;
      *) p="$(dirname "$p")/$l" ;;
    esac
    n=$((n + 1))
  done
  printf '%s\n' "$p"
}
# put_line FILE LINE…: FILE holds the LINEs, written beside it and renamed over it,
# so a full disk leaves the old value whole, not an empty file (fourth review).
# A FILE that is a symlink to a file (stow, a dotfiles folder) is written
# through: the file it names is replaced beside itself, and the link stays
# (sixth review). 0 written; 2 something not a file is in the way (PUT_PATH:
# a folder, which a rename would put it inside; a link to no file, dangling or
# to a folder; a file where a folder above it goes); 1 the write failed, its
# words in PUT_ERR.
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
# (no room, no permission, a read-only disk) is the machine's, 5, as each
# script's header says: these are this install's own files, never the
# release's, and 3 counted against it (ninth review).
put_failed() {
  if [ "$1" = 2 ]; then
    echo "$PUT_PATH is in the way, and no deploy or upgrade made it. Move it away, then try again. Nothing was changed."
    exit 2
  fi
  [ -z "$PUT_ERR" ] || printf '%s\n' "$PUT_ERR" >&2
  echo "$2"
  machine_short
}

# ---- The upgrade lock ----
# When a process started, as ps tells it in this run's time zone: how the
# holder line (owner) has always been written, and how a release before this
# one reads it, so it stays that way. Read in two zones the same start differs:
# a holder started from a shell with TZ set (or by the timer, with none) was
# taken for gone by a run in another zone, and its lock taken while it ran. So
# the holder also writes its start in UTC beside it (owner.utc), and that is
# what this release judges by when it is there (review of HB-1067).
proc_start() { LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//'; }
proc_start_utc() { LC_ALL=C TZ=UTC0 ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//'; }
# Whether $2 is when pid $1 started, in this zone or in UTC.
started_as() { [ -n "$2" ] && { [ "$2" = "$(proc_start "$1")" ] || [ "$2" = "$(proc_start_utc "$1")" ]; }; }
lock_left_over() {
  local owner pid utc
  owner="$(cat "$LOCK_PATH/owner" 2>/dev/null)" || owner=""
  if [ -z "$owner" ]; then [ -n "$(find "$LOCK_PATH" -maxdepth 0 -mmin +60 2>/dev/null)" ]; return; fi
  pid="${owner%% *}"
  case "$pid" in
    ''|*[!0-9]*) return 0 ;;
  esac
  if [ "$owner" = "$pid" ]; then ! kill -0 "$pid" 2>/dev/null; return; fi
  utc="$(cat "$LOCK_PATH/owner.utc" 2>/dev/null)" || utc=""
  case "$utc" in
    "$pid "?*) [ "$utc" != "$pid $(proc_start_utc "$pid")" ] ;;
    *) ! started_as "$pid" "${owner#* }" ;;
  esac
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
  # owner.utc first: a reader that finds it with no owner yet takes the lock as just made.
  if LOCK_ERR="$( { export LC_ALL=C; printf '%s\n' "$ME_UTC" > "$LOCK_PATH/owner.utc" && printf '%s\n' "$ME" > "$LOCK_PATH/owner.$$" && mv -f "$LOCK_PATH/owner.$$" "$LOCK_PATH/owner"; } 2>&1 )"; then
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

# ---- The dependencies' lock ----
# ensure-deps.sh's (its DEPS_LOCK: the same folder, name and holder line, a
# pid and its start in UTC; one with no holder a minute after it was made is
# a leftover, HB-1377), held while node_modules is moved aside or put back
# (HB-1212); each script says when. deps_lock: 0 held (DEPS_HELD=1), or
# none to be had at all (no room, no permission), and the move goes on
# without it, as an install does; 1 another install has held it for DEPS_WAIT
# seconds. deps_unlock lets go of it, only as its holder. Reached through a
# link, DEPS_LOCK_OLD too, the lock keyed on the path as given that the
# scripts of releases before 2.193.0 take, after DEPS_LOCK, as ensure-deps.sh
# takes it (review of HB-1377); empty when the path has no link.
# deps_holder_gone LOCK: the run that made LOCK is gone.
deps_holder_gone() {
  local owner pid
  owner="$(cat "$1/owner" 2>/dev/null)" || owner=""
  if [ -z "$owner" ]; then [ -n "$(find "$1" -maxdepth 0 -mmin +1 2>/dev/null)" ]; return; fi
  pid="${owner%% *}"
  case "$pid" in
    ''|*[!0-9]*) return 0 ;;
  esac
  if [ "$owner" = "$pid" ]; then ! kill -0 "$pid" 2>/dev/null; else [ "$owner" != "$pid $(proc_start_utc "$pid")" ]; fi
}
# deps_take LOCK: 0 held, its holder written; 2 none to be had; 1 another
# install has held it for DEPS_WAIT seconds.
deps_take() {
  local waited=0
  until mkdir "$1" 2>/dev/null; do
    [ -d "$1" ] || return 2
    find "$1.takeover" -maxdepth 0 -mmin +1 -exec rmdir {} \; 2>/dev/null || true
    if deps_holder_gone "$1" && mkdir "$1.takeover" 2>/dev/null; then
      if deps_holder_gone "$1"; then rm -rf "$1"; fi
      rmdir "$1.takeover"
      continue
    fi
    [ "$waited" != 0 ] || echo "Waiting for an install of the dependencies in $DIR to finish before moving them…"
    waited=$((waited + 1))
    [ "$waited" -lt "$DEPS_WAIT" ] || return 1
    sleep 1
  done
  # A holder it could not write would read as a run just begun: let go, and on without it.
  { printf '%s\n' "$DEPS_ME" > "$1/owner.$$" && mv -f "$1/owner.$$" "$1/owner"; } 2>/dev/null && return 0
  rm -rf "$1"
  return 2
}
deps_lock() {
  local rc=0
  [ "$DEPS_HELD" != 1 ] || return 0
  deps_take "$DEPS_LOCK" || rc=$?
  [ "$rc" != 1 ] || return 1
  [ "$rc" = 0 ] || return 0
  DEPS_HELD=1
  [ -n "$DEPS_LOCK_OLD" ] || return 0
  rc=0; deps_take "$DEPS_LOCK_OLD" || rc=$?
  [ "$rc" = 1 ] || return 0
  echo "The install that holds it is by a release before 2.193.0, under the lock it keys on $DIR as given: $DEPS_LOCK_OLD. If no npm is running there, that is the one to remove: rm -r \"$DEPS_LOCK_OLD\""
  deps_unlock
  return 1
}
deps_unlock() {
  local l
  [ "$DEPS_HELD" = 1 ] || return 0
  DEPS_HELD=0
  for l in "$DEPS_LOCK" "$DEPS_LOCK_OLD"; do
    [ -z "$l" ] || [ "$(cat "$l/owner" 2>/dev/null)" != "$DEPS_ME" ] || rm -rf "$l"
  done
  return 0
}

# restore_deps: the dependencies a run moved aside (node_modules.prev, or
# with ASIDE=1 the working ones moved and none there now) put back, CUR's.
# Under the dependencies' lock (deps_lock), let go before the restart that
# follows, whose ensure-deps.sh takes it. One this run cannot have within half
# an hour leaves them where they are and fails (1): the record stays, and the
# next run's repair puts them back under the lock. Taken for done, the record
# went, the next run deleted node_modules.prev as a leftover, and the old
# release was left on the failed install's partial tree (review of HB-1212).
# Not moved without the lock either: what holds it that long is most likely
# an npm at work in that very tree.
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

# ---- A release put back that did not come up ----
# kept_tries RECORD: the tries to restart it that RECORD counts (its `tries`
# lines: each script's back_down writes them, HB-1456).
kept_tries() {
  local n
  n="$(sed -n 's/^tries //p' "$1" 2>/dev/null | tail -n 1)"
  case "$n" in
    ''|*[!0-9]*) n=0 ;;
  esac
  echo "$n"
}
# kept_record RECORD: a restart back from it was tried already.
kept_record() { grep -qx back "$1" 2>/dev/null || grep -q '^tries ' "$1" 2>/dev/null; }

# ---- A git checkout ----
# checkout_recorded ARG…: git checkout ARG… under the record of the change in
# progress (FROM_FILE, beside the lock). Every checkout under the record writes
# its holder there first, by the process that becomes git (pid and start time,
# as the lock's holder): a kill in the checkout leaves .git/index.lock, and
# every later upgrade or deploy failed on it.
# Not with a lock already there: this checkout cannot take it and makes no lock
# of its own, and a line written now left the record newer than the lock of the
# git that was killed alone, so that lock never read as this run's (below).
checkout_recorded() {
  sh -c '[ -e .git/index.lock ] || printf "git %s %s\n" "$$" "$(LC_ALL=C ps -o lstart= -p $$ 2>/dev/null | tr -s " " | sed "s/^ //;s/ $//")" >> "$1"; shift; exec git checkout "$@"' _ "$FROM_FILE" "$@"
}

# ---- A run cut off part-way, in a git checkout ----
# Each read its record (FROM_FILE) into FROM and TO, and names itself in what
# it says (RUN_NOUN: upgrade, deploy). A copy in each script before, with no
# test holding the two the same (HB-1483).
# git_running_here: a git running in this checkout, whoever started it: its
# pid, or "unknown" when this machine has no way to tell. A commit waiting in
# its editor holds the lock for as long as the person takes, however old the
# lock looks.
git_running_here() {
  local here p comm cwd line pid=""
  here="$(pwd -P)"
  if [ -d "/proc/$$" ]; then
    # Read with the builtin, not $(cat): one cat per process on the machine
    # took 1.7 s with 900 running, and longer the busier it was (HB-0505).
    for p in /proc/[0-9]*; do
      { read -r comm < "$p/comm"; } 2>/dev/null || continue
      case "$comm" in
        git|git-*) ;;
        *) continue ;;
      esac
      cwd="$(readlink "$p/cwd" 2>/dev/null)" || continue
      case "$cwd/" in
        "$here/"*) echo "${p#/proc/}"; return 0 ;;
      esac
    done
    return 1
  fi
  command -v lsof >/dev/null 2>&1 || { echo unknown; return 0; }
  while IFS= read -r line; do
    case "$line" in
      p*) pid="${line#p}" ;;
      n*)
        case "${line#n}/" in
          "$here/"*) echo "$pid"; return 0 ;;
        esac ;;
    esac
  done < <(lsof -a -c git -d cwd -Fpn 2>/dev/null)
  return 1
}
# clear_own_index_lock: .git/index.lock goes only when it is shown to be that
# checkout's own: the record names a git, that git is gone, the lock is no
# older than the record (the record is written first), it is not fresh, and no
# other git is running here. Anything else stays and is said.
# 0 clear to go on; 1 a git of this record's is running, or the lock is not its own.
clear_own_index_lock() {
  local word pid start named=0
  while read -r word pid start; do
    [ "$word" = git ] || continue
    named=1
    if [ -n "$start" ]; then ! started_as "$pid" "$start" || { echo "The checkout that $RUN_NOUN started is still running (pid $pid) — try again once it ends."; return 1; }
    elif kill -0 "$pid" 2>/dev/null; then echo "The checkout that $RUN_NOUN started is still running (pid $pid) — try again once it ends."; return 1; fi
  done < "$FROM_FILE"
  [ -e .git/index.lock ] || return 0
  local live
  if live="$(git_running_here)"; then
    if [ "$live" != unknown ]; then echo "$DIR/.git/index.lock is held by a git running there (pid $live), which this $RUN_NOUN did not start — try again once it ends."; return 1; fi
    named=0
  fi
  if [ "$named" = 1 ] && [ ! "$FROM_FILE" -nt .git/index.lock ] && [ -n "$(find .git/index.lock -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
    echo "Removing the .git/index.lock the $RUN_NOUN that was cut off left behind."
    rm -f .git/index.lock; return 0
  fi
  echo "$DIR/.git/index.lock is in the way, and nothing shows it is that $RUN_NOUN's own (one a few minutes old may be: try again then). If no git is running there, remove it: rm $DIR/.git/index.lock"
  return 1
}
# save_other_edits, then repair_tree: back to the release the record names
# (FROM; the one it went to, TO). Forced, and through the new one first
# when the tree is part-way: a checkout cut off leaves HEAD and the index on the
# old one with files rewritten, which a plain checkout kept (mixed code, then
# refused as local changes for good). The run started from a clean tree, and
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

# ---- A rollback, written down for the next start ----
# older_release A B: A and B are releases (tags), and A is the older one.
older_release() {
  case "$1" in
    v[0-9]*) ;;
    *) return 1 ;;
  esac
  case "$2" in
    v[0-9]*) ;;
    *) return 1 ;;
  esac
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sed 's/-/~/' | sort -V | tail -1 | sed 's/~/-/')" = "$2" ]
}
# A rollback, written down for the next start (HB-0840). What Hatchabot keeps
# for each agent to take up after a restart (agent_holds, from v2.191.0) is
# neither served nor cleared by a release from before it, nor a kind of it by
# a release from before that kind, and the next upgrade took it up days or
# weeks on. So, just before the restart onto the release gone back to, the
# time goes in <database>.rolled-back, beside the database, and the first
# start of a release that knows the table lets go of every hold kept before
# it (src/store/rollbackMark.ts). The database is found as the service finds
# it: HATCHABOT_DB (or AGENTCLAW_DB) in .env, else data/hatchabot.sqlite.
# Never fails the rollback. restart.sh keeps a copy of it and of
# rolled_back_note (test/nightScripts.test.ts holds them equal).
# mark_rolled_back DIR [RECORD]
# RECORD, the run's record: for a note the run may take away again (an older
# release named, which may never start: unmark_rolled_back). The note already
# there, if any, is kept whole in <note>.prev, to be put back then: written
# over and then removed, a note kept for a later release's holds, or after a
# drop the database refused, was lost (HB-1455). With none there, or no
# RECORD, a .prev an earlier run left goes, never to be put back over this
# note. Then the record says `noted <time>`, so that the repair of a run cut
# off before it could take the note away does it.
mark_rolled_back() {
  local note mark at
  systemd_major "$1/.env"   # here, so that it is asked once a run, not in each reading
  note="$(rolled_back_note "$1")"; mark="${note#*:}"
  [ -n "$mark" ] || return 0
  [ "${note%%:*}" != unread ] || echo "Could not read $1/.env to find the database (node failed, or with none to read it with, it has a line bash cannot read as systemd does), so this rollback is written down beside the one the service opens when .env names none, ${mark%.rolled-back}. If .env names another (HATCHABOT_DB), the next start may take up what the release left had still to do for its agents."
  if [ ! -d "$(dirname "$mark")" ]; then
    [ "${note%%:*}" != named ] || echo "The folder of the database .env names (${mark%.rolled-back}) is not there, so this rollback was not written down beside it: the next start may take up what the release left had still to do for its agents."
    return 0
  fi
  # The advice gives the rollback's own time: typed later, the time then let
  # go of what the release gone back to kept since (review of HB-0840).
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # A .prev left there once the release named comes up is harmless: it goes
  # back only over the note written with it (unmark_rolled_back), and goes
  # at the next note. Without RECORD too: a note for a release that ran stands
  # for every hold kept before it, the .prev's too, and a repair put one left
  # back over it (review of HB-1456).
  if [ -n "${2:-}" ] && [ -f "$mark" ]; then cp -p "$mark" "$mark.prev" 2>/dev/null || rm -f "$mark.prev" 2>/dev/null || true
  else rm -f "$mark.prev" 2>/dev/null || true; fi
  [ -z "${2:-}" ] || printf 'noted %s\n' "$at" >> "$2" 2>/dev/null || true
  { printf '%s\n' "$at" > "$mark.tmp" && mv -f "$mark.tmp" "$mark"; } 2>/dev/null || {
    rm -f "$mark.tmp" 2>/dev/null || true
    echo "Could not write $mark (a full disk?), so the next start may take up what the release left had still to do for its agents. Once there is room: printf '%s\n' $at > \"$mark\""
  }
  return 0
}
# systemd_major FILE: the first number of `systemctl --version`, in
# SYSTEMD_MAJOR, for the reader of systemd's rules (`systemd`, in node). From
# v254 a line after a comment that ends in a backslash is a line of its own;
# before, it went on the comment. Read always the old way, `# C:\data\` and
# then a HATCHABOT_DB line named the database to systemd 254 and nothing here
# (HB-1457). Asked once, and only of a FILE with a backslash at the end of a
# line, the one place the two differ. With no systemctl to ask, empty: read as
# v254 reads, as no systemd reads .env there (on Linux Hatchabot runs as a
# systemd unit; a Mac's launchd job sources .env with bash, which reads that
# line too), and that is the rule of every systemd since 2023 and of
# Hatchabot's own readers. Never taken from the environment: one a caller
# exported chose the rule, so it is unset here, before any reading. The same
# in every script that reads .env so (test/backupKeyLine.test.ts, READERS).
unset SYSTEMD_MAJOR
systemd_major() {
  [ -z "${SYSTEMD_MAJOR+x}" ] || return 0
  LC_ALL=C grep -q -e '\\$' -e $'\\\\\r' "$1" 2>/dev/null || return 0
  SYSTEMD_MAJOR="$( { systemctl --version 2>/dev/null || true; } | sed -n '1s/^[^0-9]*\([0-9][0-9]*\).*/\1/p')"
}
env_named() {
  # ENV_READ: 1 once .env was read through (a node that failed reads nothing;
  # with no node on Linux, only what bash reads as systemd does, below).
  # A HATCHABOT_ name is read under its name from before the rename too
  # (AGENTCLAW_), which the service takes when the new one is not set
  # (applyLegacyEnv): a pre-rename AGENTCLAW_IMAGE was the service's image,
  # and the upgrade's and setup's was the default (HB-1379).
  local kv k
  local -a names=()
  for k in "$@"; do
    names+=("$k")
    case "$k" in
      HATCHABOT_*) names+=("AGENTCLAW_${k#HATCHABOT_}") ;;
    esac
  done
  ENV_READ=''
  systemd_major .env
  for k in "${names[@]}"; do printf -v "ENV_$k" '%s' ''; printf -v "ENVSET_$k" '%s' ''; done
  # The reading, in the < <( ... ) below, says what it is here: bash 3.2
  # finds where one ends by its quotes and parentheses, comments in it too
  # (review of HB-1529).
  # - On a Mac, as the launchd job sources it (launchd-plist.sh): by
  #   /bin/bash, with launchd's few settings and nothing on its input; the
  #   PATH is this shell's, not the job's own (the plist's). In a subshell of
  #   this one it had the caller's whole environment, its shell's variables
  #   and its input (HB-1381).
  # - With no node to ask (a restart from cron or a bare ssh, with an nvm
  #   node off its PATH): what bash reads as systemd does, NAME=value with
  #   spaces or tabs around the = (only those: systemd keeps a form feed or a
  #   vertical tab) and the value whole, or quoted whole, on its line. A file
  #   with a carriage return or a backslash at a line's end, or with a value
  #   on any line that opens a quote it does not close on that line (systemd
  #   reads on into the lines after it, and they are no settings of their
  #   own), is left unread, and so is a value asked for that is quoted any
  #   other way or has a backslash in it. Unread whenever node was not
  #   there, a restart asked plain http on port 8080, and failed a listener
  #   the sed it replaced had found (review of HB-1529).
  # - Otherwise by systemd's rules, in node.
  while IFS= read -r -d '' kv; do
    k="${kv%%=*}"
    [ "$k" != . ] || { ENV_READ=1; continue; }
    printf -v "ENV_$k" '%s' "${kv#*=}"; printf -v "ENVSET_$k" '%s' 1
  done < <(
    if [ "$(uname -s)" = Darwin ]; then
      set +eu
      lj=(HOME="$HOME" PATH="$PATH")
      for k in USER LOGNAME SHELL TMPDIR; do [ -z "${!k:-}" ] || lj+=("$k=${!k}"); done
      env -i "${lj[@]}" /bin/bash -c 'for k in "$@"; do unset "$k"; done; set -a; . ./.env >/dev/null 2>&1; set +a
        for k in "$@"; do [ -z "${!k+x}" ] || printf "%s=%s\0" "$k" "${!k}"; done; printf ".=\0"' launchd-job "${names[@]}" </dev/null
    elif ! command -v node >/dev/null 2>&1; then
      set +e
      sp=$' \t'
      [ -r .env ] || exit 0
      LC_ALL=C grep -q -e $'\r' -e '\\$' .env 2>/dev/null && exit 0
      while IFS= read -r kv || [ -n "$kv" ]; do
        kv="${kv#"${kv%%[!$sp]*}"}"
        [ -n "$kv" ] && [ "${kv:0:1}" != "#" ] && [ "${kv:0:1}" != ";" ] && [[ "${kv:1}" == *=* ]] || continue
        kv="${kv:1}"; kv="${kv#*=}"; kv="${kv#"${kv%%[!$sp]*}"}"; kv="${kv%"${kv##*[!$sp]}"}"
        [[ "$kv" == [\'\"]* ]] || continue
        [[ "$kv" == \'*\' && "${kv:1:${#kv}-2}" != *\'* ]] || [[ "$kv" == \"*\" && "${kv:1:${#kv}-2}" != *[\"\\]* ]] || exit 0
      done < .env
      for k in "${names[@]}"; do
        kv="$(LC_ALL=C grep -E "^[$sp]*$k[$sp]*=" .env 2>/dev/null | tail -n 1)"
        [ -n "$kv" ] || continue
        kv="${kv#*=}"; kv="${kv#"${kv%%[!$sp]*}"}"; kv="${kv%"${kv##*[!$sp]}"}"
        if [[ "$kv" == \'*\' && "${kv:1:${#kv}-2}" != *\'* ]]; then kv="${kv:1:${#kv}-2}"
        elif [[ "$kv" == \"*\" && "${kv:1:${#kv}-2}" != *[\"\\]* ]]; then kv="${kv:1:${#kv}-2}"
        elif [[ "$kv" == [\'\"]* || "$kv" == *\\* ]]; then exit 0
        fi
        printf '%s=%s\0' "$k" "$kv"
      done
      printf '.=\0'
    else
      node -e '
    const systemd = (t, ver) => {
      // ver: the first number of `systemctl --version` (systemd_major). Before v254 a comment ending in a
      // backslash went on over the next line; from v254, and with no systemctl to ask, that line is read.
      const joins = Number(ver) > 0 && Number(ver) < 254;
      const out = {}; let st = "prekey", k = "", v = "", lw = -1;
      // lw: where the run of spaces and tabs at the end of the value starts (last_value_whitespace in
      // systemd), the only part trimmed: an escaped space or tab is kept, as systemd keeps it.
      const done = () => { if (k) out[k] = lw >= 0 ? v.slice(0, lw) : v; k = ""; v = ""; lw = -1; st = "prekey"; };
      for (const c of t) {
        const nl = c === "\n" || c === "\r", ws = c === " " || c === "\t" || nl;
        if (st === "prekey") { if (c === "#" || c === ";") st = "comment"; else if (!ws) { k = c; st = "key"; } }
        else if (st === "comment") { if (c === "\\") st = "commentesc"; else if (nl) st = "prekey"; }
        else if (st === "commentesc") st = nl && !joins ? "prekey" : "comment";
        else if (st === "key") { if (nl) { k = ""; st = "prekey"; } else if (c === "=") { k = k.replace(/[ \t]+$/, ""); st = "prevalue"; } else k += c; }
        else if (st === "prevalue") { if (nl) done(); else if (c === "\x27") st = "single"; else if (c === "\"") st = "double"; else if (c === "\\") st = "esc"; else if (!ws) { v += c; st = "value"; } }
        else if (st === "value") { if (nl) done(); else if (c === "\\") { st = "esc"; lw = -1; } else { if (c !== " " && c !== "\t") lw = -1; else if (lw < 0) lw = v.length; v += c; } }
        else if (st === "esc") { st = "value"; if (!nl) v += c; }
        else if (st === "single") { if (c === "\x27") st = "prevalue"; else v += c; }
        else if (st === "double") { if (c === "\"") st = "prevalue"; else if (c === "\\") st = "doubleesc"; else v += c; }
        else if (st === "doubleesc") { st = "double"; if (c !== "\n") v += "\"\\`$".includes(c) ? c : "\\" + c; }
      }
      // The end of the file ends a value as a newline does, quoted or escaped as far as it went, as
      // systemd keeps it: a quote never closed, or a backslash last, lost its key here.
      if (["prevalue", "value", "esc", "single", "double", "doubleesc"].includes(st)) done();
      return out;
    };
    const out = systemd(require("node:fs").readFileSync(".env", "utf8"), process.argv[1]);
    for (const k of process.argv.slice(2)) if (Object.prototype.hasOwnProperty.call(out, k)) process.stdout.write(k + "=" + out[k] + "\0");
    process.stdout.write(".=\0");' "${SYSTEMD_MAJOR:-}" "${names[@]}" 2>/dev/null || true
    fi
  )
  for k in "$@"; do
    case "$k" in
      HATCHABOT_*) ;;
      *) continue ;;
    esac
    kv="ENVSET_$k"; [ -z "${!kv}" ] || continue
    kv="ENVSET_AGENTCLAW_${k#HATCHABOT_}"; [ -n "${!kv}" ] || continue
    kv="ENV_AGENTCLAW_${k#HATCHABOT_}"
    printf -v "ENV_$k" '%s' "${!kv}"; printf -v "ENVSET_$k" '%s' 1
  done
}
# service_port VALUE: the port the service listens on with VALUE as its PORT,
# read as the service reads it (Number(), as doctor's servicePort): 8080 when
# it is unset, empty or no number. On Linux a " # note" after the value is
# part of it, as systemd keeps it: the service then listens on 8080, as for
# no PORT (before 2.193.0 it did not start), and a URL with that value in it
# is none at all (HB-1529). With no node to ask, digits alone are a port,
# with the ASCII white space Number takes off around them taken off too (a
# form feed systemd keeps; review of HB-1529). The same in each script that
# asks the listener (test/doctorServiceTargets.test.ts).
service_port() {
  local n ws=$' \t\n\v\f\r'
  node -e 'process.stdout.write(String(Number(process.argv[1]) || 8080))' -- "$1" 2>/dev/null && return 0
  n="${1#"${1%%[!$ws]*}"}"; n="${n%"${n##*[!$ws]}"}"
  case "$n" in
    ''|*[!0-9]*) echo 8080 ;;
    *)
      n="${n#"${n%%[!0]*}"}"   # the zeros it starts with dropped, as Number reads them
      echo "${n:-8080}" ;;
  esac
}
# rolled_back_note DIR: where mark_rolled_back writes, for the service in
# DIR: beside the database it opens, `named:<note>` when .env names it,
# `default:<note>` when it does not, `unread:<note>` (the default's) when a
# .env is there but could not be read (no node, or one that failed: said, not
# passed by), or `none:` when .env names none (an empty
# HATCHABOT_DB: a database the service makes anew at each start). .env is read
# as the service reads it (env_named: systemd's EnvironmentFile rules on
# Linux, where a quoted value or an escaped space is as systemd keeps it and a
# " # ..." after a value is part of it; the launchd job's bash on a Mac):
# HATCHABOT_DB, else AGENTCLAW_DB (the name before the rename), else
# data/hatchabot.sqlite, or data/agentclaw.sqlite when only that is there.
# Read with sed, a comment taken off, `My\ Data` named a folder that is not
# there, and a note written for systemd's value was not where the service
# looked (review of HB-0840).
rolled_back_note() {
  ( cd "$1" 2>/dev/null || exit 0
    env_named HATCHABOT_DB AGENTCLAW_DB
    local db how=named
    if [ -n "$ENVSET_HATCHABOT_DB" ]; then db="$ENV_HATCHABOT_DB"
    elif [ -n "$ENVSET_AGENTCLAW_DB" ]; then db="$ENV_AGENTCLAW_DB"
    else
      how=default; [ -n "$ENV_READ" ] || [ ! -e .env ] || how=unread
      db=data/hatchabot.sqlite
      [ -e "$db" ] || [ ! -e data/agentclaw.sqlite ] || db=data/agentclaw.sqlite
    fi
    [ -n "$db" ] || { printf 'none:\n'; exit 0; }
    case "$db" in
      /*) ;;
      *) db="$1/$db" ;;
    esac
    printf '%s:%s\n' "$how" "$db.rolled-back" )
}
# The note is written only when a release was really left (review of HB-0840).
# The record says `restarted` before the restart is asked for, so that a
# repair restarts the service back; that says nothing of whether the service
# manager got to restart it. So each record says `says-started` from its
# first line on, and `started` goes in once the service manager has restarted
# the service onto the new release (restart.sh, told the record in
# HATCHABOT_RESTART_RECORD, or deploy-release.sh itself), and `back` once it
# has restarted it back onto the release gone back to. left_ran RECORD: the
# release this run leaves started, and nothing restarted the service back
# since, so going back now is a rollback to write down. A restart.sh that
# writes neither line (ensure-deps failed first, or one of v2.191.0 and
# older, onto an older release named) left the release gone back to as it
# was, or ran one older than it, whose every kind of hold it knows and takes
# up at its start. A record with no `says-started` is one an upgrade.sh or
# deploy-release.sh of v2.191.0 and older wrote, whose `restarted` is all it
# says: read as it was.
left_ran() {
  [ -f "$1" ] || return 1
  if grep -qx says-started "$1"; then grep -qx started "$1" && ! grep -qx back "$1"
  else grep -qx restarted "$1"; fi
}
# The note this run wrote before its restart onto an older release named
# (NOTED), taken away by its rollback when the record does not say that
# release started (left_ran): it never did, and the one gone back to never
# stopped; or it is one of v2.191.0 and older, whose restart.sh writes no
# `started`, and the one gone back to knows every kind of hold it kept in
# the minutes it ran. unmark_rolled_back DIR [TIME]
# The note there before it, kept in <note>.prev (mark_rolled_back), goes back
# in its place; with none, the note goes (HB-1455). TIME, a repair's (the
# `noted` line of the run cut off): only while the note is the one written
# then, so a repair tried again never takes away the one put back, nor puts
# a .prev back over one written since (review of HB-1456).
unmark_rolled_back() {
  local note mark
  systemd_major "$1/.env"
  note="$(rolled_back_note "$1")"; mark="${note#*:}"
  [ -n "$mark" ] || return 0
  [ -z "${2:-}" ] || [ "$(cat "$mark" 2>/dev/null || true)" = "$2" ] || return 0
  if [ -f "$mark.prev" ]; then mv -f "$mark.prev" "$mark" 2>/dev/null || true
  else rm -f "$mark" 2>/dev/null || true; fi
  return 0
}

# ---- The last definition here ----
# A script that has it has every one above: each checks for it once this
# file is read, and stops before it changes anything when it has not.
upgrade_helpers_end() { :; }
