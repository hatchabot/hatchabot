# The try record the two timers keep, follow-channel.sh and follow-latest.sh:
# a release whose upgrade keeps failing (exit 3: npm ci against a lockfile that
# does not match, a driver that will not compile) is not tried every ten
# minutes for ever. After each failure in a row the wait doubles (10 min, 20,
# 40 … a day at most), and after MAX_TRIES the release is set aside like one
# that did not start (review, 2026-10-09). A full disk (exit 5) waits the same
# way but is not the release's: a disk that stayed full set a good release
# aside (HB-0470). Sourced, never run on its own: one copy, where each timer
# had its own (fourth review of HB-0470).
#
# The record: "<release> <failures> <epoch>", three fields, exactly as the
# timers of releases before read it (`read -r T_TARGET T_COUNT T_LAST`: a
# fourth field made T_LAST no number, and they started the count again; tenth
# review). Of those failures, the disk's are counted beside it, in FILE.disk:
# "<release> <the disk's>", none when there are none.
#
# tries_open FILE NAME RELEASE: read FILE's record for RELEASE into T_COUNT,
#   T_LAST and T_DISK (all 0 for another release, or none; T_DISK 0 when
#   FILE.disk is not there or names another release). NAME is where both are
#   kept meanwhile when FILE cannot be written (HELD, below).
# tries_waiting: 0 while the wait after the last failure lasts (by the release's
#   own failures; by the disk's, an hour at most, when it has none).
# note_try 0|1: one more failure in a row, 1 when it was the disk's.
# forget_tries: the release was upgraded to, or set aside.
MAX_TRIES=8
tries_open() {
  TRIES="$1"; TRIES_FOR="$3"; HELD=""
  # Kept meanwhile only in the user's own runtime folder (a tmpfs under
  # systemd, 0700 and theirs), and never through a symlink: in a shared /tmp
  # another user could plant the file, or a link, first (fourth review). With
  # none, nothing is kept and the next tick tries again.
  if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "$XDG_RUNTIME_DIR" ] && [ ! -L "$XDG_RUNTIME_DIR" ] && [ -O "$XDG_RUNTIME_DIR" ]; then
    HELD="$XDG_RUNTIME_DIR/$2"
  fi
  local from="$TRIES" t="" dt="" more=""
  [ -z "$HELD" ] || [ -L "$HELD" ] || [ ! -f "$HELD" ] || from="$HELD"
  T_COUNT=0; T_LAST=0; T_DISK=0
  { read -r t T_COUNT T_LAST more < "$from"; } 2>/dev/null || true
  case "${T_COUNT:-}${T_LAST:-}" in ''|*[!0-9]*) T_COUNT=0; T_LAST=0 ;; esac
  [ -L "$from.disk" ] || { read -r dt T_DISK more < "$from.disk"; } 2>/dev/null || true
  case "${T_DISK:-}" in ''|*[!0-9]*) T_DISK=0 ;; esac
  # Another release's, or left by a timer from before that counted on
  # without it: never more than the failures counted.
  [ "$dt" = "$TRIES_FOR" ] || T_DISK=0
  [ "$T_DISK" -le "$T_COUNT" ] || T_DISK="$T_COUNT"
  if [ "$t" != "$TRIES_FOR" ] || [ "$T_COUNT" -le 0 ]; then T_COUNT=0; T_LAST=0; T_DISK=0; fi
}
tries_waiting() {
  [ "$T_COUNT" -gt 0 ] || return 1
  # The doubling follows the release's own failures (T_COUNT less T_DISK):
  # a disk that stayed full for a day doubled the wait to a day, and the
  # release, once there was room, waited a day for its first own try. With
  # none of its own, the disk's double too, to an hour at most (55 minutes,
  # less the timer's jitter, so the tick at the hour finds it due: twelfth
  # review). Stopped at 2^8 (2555 minutes, past the day): the shift wrapped
  # from 64 on, to a try every tick (review of HB-0470).
  local own=$((T_COUNT - T_DISK)) n cap=1440 s wait
  if [ "$own" -gt 0 ]; then n="$own"; else n="$T_DISK"; cap=55; fi
  s=$((n - 1))
  [ "$s" -ge 0 ] || s=0
  [ "$s" -le 8 ] || s=8
  wait=$(( 10 * (1 << s) - 5 ))   # minutes, less 5 for the timer's own jitter: 5, 15, 35 …
  [ "$wait" -le "$cap" ] || wait="$cap"
  [ $(( $(date +%s) - T_LAST )) -lt $(( wait * 60 )) ]
}
# Written whole or not at all (`>` on a full disk emptied the record it could
# not write), else kept in HELD; and said. Under set -e a failed write ended
# the run with no word and no wait begun, so every tick ran the upgrade again
# (third review of HB-0470).
# tries_put FILE LINE [DISK_LINE]: the record and FILE.disk beside it (none
# for no DISK_LINE), each written whole or not at all; the count of the
# disk's first, so a record written never has fewer of them than it had.
tries_put() {
  if [ -n "${3:-}" ]; then
    { printf '%s\n' "$3" > "$1.disk.tmp" && mv -f "$1.disk.tmp" "$1.disk"; } 2>/dev/null || { rm -f "$1.disk.tmp" 2>/dev/null || true; return 1; }
  else
    rm -f "$1.disk" 2>/dev/null || true
  fi
  { printf '%s\n' "$2" > "$1.tmp" && mv -f "$1.tmp" "$1"; } 2>/dev/null || { rm -f "$1.tmp" 2>/dev/null || true; return 1; }
}
note_try() {
  local line dline="" disk=$((T_DISK + $1))
  line="$TRIES_FOR $((T_COUNT + 1)) $(date +%s)"; [ "$disk" = 0 ] || dline="$TRIES_FOR $disk"
  if tries_put "$TRIES" "$line" "$dline"; then
    [ -z "$HELD" ] || rm -f "$HELD" "$HELD.disk" 2>/dev/null || true
    return 0
  fi
  if [ -n "$HELD" ] && [ ! -L "$HELD" ] && [ ! -L "$HELD.disk" ] && tries_put "$HELD" "$line" "$dline"; then
    echo "Could not record this try in $TRIES (a full disk?): kept in $HELD meanwhile, so the next tries still wait."
  else
    echo "Could not record this try in $TRIES (a full disk?), so the next tick tries again. Free some space."
  fi
}
forget_tries() {
  rm -f "$TRIES" "$TRIES.disk" 2>/dev/null || true
  [ -z "$HELD" ] || rm -f "$HELD" "$HELD.disk" 2>/dev/null || true
}
