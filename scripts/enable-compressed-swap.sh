#!/usr/bin/env bash
# Compressed swap for this machine, so Hatchabot can give agents a swap
# allowance (docs/features.md → Compressed swap). Linux only; run as root:
#
#   sudo scripts/enable-compressed-swap.sh            # zswap + zstd in front of the existing swap
#   sudo scripts/enable-compressed-swap.sh --zram     # zram + zstd instead (nothing on disk)
#   scripts/enable-compressed-swap.sh --status        # what is on now (no root needed)
#   sudo scripts/enable-compressed-swap.sh --undo     # back to how it was
#
# It says what it will do and asks first. Nothing needs a reboot and the boot
# loader is not touched: the settings are written to sysfs now, and a small
# systemd unit (hatchabot-compressed-swap.service) writes them again at boot.
# Your existing swap file stays as it is.
#
# Options:
#   --zram               zram (a compressed swap device in memory) instead of zswap.
#                        Needs the zram module (Ubuntu: linux-modules-extra-$(uname -r)).
#                        Refused while a disk swap is on: turn it off first, or use zswap.
#   --pool PERCENT       zswap: the most memory its compressed pool may take (default 20).
#   --zram-size SIZE     zram: how much it may hold before compression (default: half of memory):
#                        8G, 512M, 1.5G (in 1024s), or bytes.
#   --swap-size SIZE     zswap with no swap at all: the size of the /swapfile it makes (default 8G).
#   --swappiness N       also set vm.swappiness (asked otherwise; see below). 0–200.
#   --keep-shrinker      zswap: leave the kernel's shrinker on (it writes cold compressed pages
#                        to the swap file early; off by default here). Hatchabot then gives
#                        agents no swap: their cold memory would reach the disk.
#   --yes                answer yes to everything (a provisioner); --swappiness still opt-in.
#   --dry-run            print what it would do, change nothing.
#
# Afterwards, in Hatchabot: Settings → Hosts → Defaults → "Compressed swap per
# agent" (all agents), or an agent's sheet → Advanced → Runtime → Compressed
# swap (one agent), or `hatchabot swap <agent> 2g`. `hatchabot doctor` shows the state.
set -euo pipefail

UNIT=hatchabot-compressed-swap.service
# Every file and folder of the machine's that it reads or writes, named once
# here: test/compressedSwapScript.test.ts runs the whole script with each of
# them moved into a made-up machine, so no test reaches the real swap.
UNIT_FILE=/etc/systemd/system/$UNIT
HELPER=/usr/local/sbin/hatchabot-compressed-swap
CONF=/etc/hatchabot/compressed-swap.conf
STATE=/etc/hatchabot/compressed-swap.state
SYSCTL=/etc/sysctl.d/90-hatchabot-swap.conf
MODULES_LOAD=/etc/modules-load.d/hatchabot-compressed-swap.conf
FSTAB=/etc/fstab
SWAPFILE=/swapfile
ZS=/sys/module/zswap/parameters
BLOCK=/sys/block
SWAPS=/proc/swaps
MEMINFO=/proc/meminfo
CRYPTO=/proc/crypto
SWAPPINESS_NOW=/proc/sys/vm/swappiness
ZRAM="$BLOCK/zram0"

ACTION=enable MODE=zswap POOL=20 ZRAM_SIZE= SWAP_SIZE=8G SWAPPINESS= SHRINKER=N YES=0 DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --status) ACTION=status ;;
    --undo) ACTION=undo ;;
    --zram) MODE=zram ;;
    --zswap) MODE=zswap ;;
    --pool) POOL="${2:?--pool needs a percent}"; shift ;;
    --zram-size) ZRAM_SIZE="${2:?--zram-size needs a size}"; shift ;;
    --swap-size) SWAP_SIZE="${2:?--swap-size needs a size}"; shift ;;
    --swappiness) SWAPPINESS="${2:?--swappiness needs a number}"; shift ;;
    --keep-shrinker) SHRINKER=Y ;;
    --yes|-y) YES=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
ask() { # ask "question" → 0 for yes
  [ "$YES" = 1 ] && return 0
  [ -t 0 ] || die "no terminal to ask on; re-run with --yes (or --dry-run to see the plan)"
  local a; read -r -p "$1 [y/N] " a; case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
run() { if [ "$DRY" = 1 ]; then printf '  would run: %s\n' "$*"; else "$@"; fi; }
write() { # write <file> <content> (as root, 0644)
  if [ "$DRY" = 1 ]; then printf '  would write %s:\n%s\n' "$1" "$(printf '%s\n' "$2" | sed 's/^/    | /')"; return; fi
  mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1.tmp"; chmod 0644 "$1.tmp"; mv "$1.tmp" "$1"
}
# zram_bytes SIZE: SIZE in bytes, rounded up to a page, as the kernel keeps
# a zram device's disksize; status 1, and nothing, for what is not a size.
# A number of bytes, or one with K, M, G or T (KB, KiB the same: all in
# 1024s, as the kernel counts), a fraction too (1.5G). The kernel reads only
# a whole number before the letter: 1.5G written as it was made a device of
# one page, and 8GiB was read here as 8 bytes, so every rerun at either
# size made the device again (review of HB-1112). disksize is written in
# these bytes, so the kernel keeps what was asked for.
zram_bytes() {
  local v="${1^^}" page
  [[ "$v" =~ ^([0-9]+(\.[0-9]+)?)(([KMGT])(I?B)?)?$ ]] || return 1
  page="$(getconf PAGESIZE 2>/dev/null || echo 4096)"
  awk -v n="${BASH_REMATCH[1]}" -v u="${BASH_REMATCH[4]}" -v p="$page" 'BEGIN {
    m = (u == "K") ? 1024 : (u == "M") ? 1048576 : (u == "G") ? 1073741824 : (u == "T") ? 1099511627776 : 1
    b = int((n * m + p - 1) / p) * p
    if (b < p) exit 1
    printf "%.0f", b }'
}
# What one of this script's own files ($CONF, $STATE) says NAME is ('' for
# nothing), read in a subshell so none of its other names leak in. conf_value FILE NAME
conf_value() { [ -f "$1" ] || return 0; ( unset "$2"; . "$1" >/dev/null 2>&1; printf '%s' "${!2:-}" ) || true; }
# The command that sets up again what $CONF says, so a rerun changes nothing
# but the files this script writes (a zram0 is not made again at another size).
again() {
  local m z p
  m="$(conf_value "$CONF" MODE)" z="$(conf_value "$CONF" ZRAM_SIZE)" p="$(conf_value "$CONF" POOL)"
  if [ "$m" = zram ]; then
    printf 'sudo %s --zram%s' "$0" "$( [ "${z:-0}" = 0 ] || printf ' --zram-size %s' "$z")"
  else
    printf 'sudo %s%s%s' "$0" "${p:+ --pool $p}" "$( [ "$(conf_value "$CONF" SHRINKER)" != Y ] || printf ' --keep-shrinker')"
  fi
}
human() { awk -v b="$1" 'BEGIN { if (b>=1073741824) printf "%.1f GB", b/1073741824; else printf "%d MB", b/1048576 }'; }

# zram refuses a reset (EBUSY) while anything holds the device: udev probing
# it just after the swapoff, for one. Tried again a few times, udev's queue
# let settle in between where udevadm is there; the last try's words shown.
zram_reset() {
  local try
  for try in 1 2 3 4; do
    run sh -c "echo 1 > $ZRAM/reset" 2>/dev/null && return 0
    if command -v udevadm >/dev/null 2>&1; then udevadm settle --timeout=5 >/dev/null 2>&1 || true; fi
    sleep 1
  done
  run sh -c "echo 1 > $ZRAM/reset"
}
# /dev/zram0 is off from the swapoff of a resize until the helper has it on
# again. A failure in between ended the run with the shell's own words (set
# -e), zram0 left off and nothing said (review of HB-1112). Now, on any exit
# but 0 while it is off (ZRAM_OFF: `reset` until it is reset, then `made`),
# what the machine has and how to get it back. ZRAM_WAS: its size before, in bytes.
ZRAM_OFF='' ZRAM_WAS=''
zram_left_off() {
  local rc=$?
  if [ "$rc" = 0 ] || [ -z "$ZRAM_OFF" ]; then return 0; fi
  {
    echo
    if [ "$ZRAM_OFF" = reset ]; then
      echo "Error: /dev/zram0 is off: it was switched off to be made again at $ZRAM_SIZE, but it could not be reset (above: something still holds it). Nothing else was changed."
      echo "  Agents have no compressed swap until it is on again. To put it back as it was, at $(human "$ZRAM_WAS"): sudo swapon -p 100 /dev/zram0"
      echo "  Or run this again in a minute, once nothing holds it."
    else
      echo "Error: /dev/zram0 is off: it was switched off and reset to be made again at $ZRAM_SIZE, and that stopped part-way (above)."
      echo "  Agents have no compressed swap until it is on again. To make it, run this again (sudo $0 --zram --zram-size $ZRAM_SIZE), or at the size it had: sudo $0 --zram --zram-size $ZRAM_WAS"
    fi
  } >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || die "Linux only. On a Mac, Docker Desktop's VM already compresses memory its own way."

status() {
  say "Compressed swap on $(hostname) (kernel $(uname -r))"
  if [ -d "$ZS" ]; then
    note "zswap: enabled=$(cat $ZS/enabled) compressor=$(cat $ZS/compressor) zpool=$(cat $ZS/zpool 2>/dev/null || echo -) max_pool_percent=$(cat $ZS/max_pool_percent) shrinker=$(cat $ZS/shrinker_enabled 2>/dev/null || echo -)"
    local pool stored
    pool=$(awk '/^Zswap:/ {print $2*1024}' "$MEMINFO"); stored=$(awk '/^Zswapped:/ {print $2*1024}' "$MEMINFO")
    if [ -n "$stored" ] && [ "${stored:-0}" -gt 0 ]; then
      note "zswap pool: $(human "$stored") stored in $(human "$pool") ($(awk -v s="$stored" -v p="$pool" 'BEGIN { printf "%.2f", (p>0)?s/p:0 }'):1)"
    else
      note "zswap pool: empty"
    fi
  else
    note "zswap: not in this kernel"
  fi
  local d
  for d in "$BLOCK"/zram*; do
    [ -e "$d/mm_stat" ] || continue
    # mm_stat: orig_data_size compr_data_size mem_used_total …
    read -r orig compr used _ < "$d/mm_stat"
    note "${d##*/}: algorithm $(sed 's/.*\[\(.*\)\].*/\1/' "$d/comp_algorithm") · disksize $(human "$(cat "$d/disksize")") · $(human "$orig") stored in $(human "$used")$( [ "$orig" -gt 1048576 ] && [ "$used" -gt 0 ] && awk -v o="$orig" -v u="$used" 'BEGIN { printf " (%.2f:1)", o/u }')"
  done
  note "swap devices:"; sed 's/^/    /' "$SWAPS"
  note "vm.swappiness=$(cat "$SWAPPINESS_NOW")"
  if [ -f "$UNIT_FILE" ]; then
    note "boot unit: $UNIT $(systemctl is-enabled "$UNIT" 2>/dev/null || true) ($(. "$CONF" 2>/dev/null; echo "mode=${MODE:-?}"))"
  else
    note "boot unit: not installed (nothing is re-applied at boot)"
  fi
  # A helper this script's release did not write: one written before 2.193.0
  # turned zswap off in zram mode beside a disk swap that came back (HB-1459),
  # and it stays until this script writes it again. Its own path aside (SELF:
  # where the script was run from, helper_state's `path`).
  if [ -f "$HELPER" ] && [ "$(helper_state)" = other ]; then
    note "boot helper: $HELPER was written by another release of this script, and does what that one did at boot. To bring it up to date, run this again with the same settings: $(again)"
  fi
  # In the order Hatchabot judges it (src/domain/swap.ts, parseSwapProbe),
  # so the two never disagree: zram alone; zram with disk swap needs zswap;
  # zswap's shrinker writes agents' cold memory to disk early. The verdict is
  # left in VERDICT (zswap, zram or none) and WHY, for enable to go by.
  local zram disk zon=N shr=N
  VERDICT=none WHY=''
  zram="$(awk 'NR>1 && $1 ~ /^\/dev\/zram[0-9]+$/' "$SWAPS" | wc -l)"
  disk="$(awk 'NR>1 && $1 !~ /^\/dev\/zram[0-9]+$/' "$SWAPS" | wc -l)"
  case "$(cat $ZS/enabled 2>/dev/null)" in [Yy]|1) zon=Y ;; esac
  case "$(cat $ZS/shrinker_enabled 2>/dev/null)" in [Yy]|1) shr=Y ;; esac
  if [ "$zram" -gt 0 ] && [ "$disk" -eq 0 ]; then VERDICT=zram
  elif [ "$zram" -gt 0 ] && [ "$zon" != Y ]; then WHY=zram-disk
  elif [ "$zon" = Y ] && [ "$disk" -gt 0 ] && [ "$shr" = Y ]; then WHY=shrinker
  elif [ "$zon" = Y ] && [ "$disk" -gt 0 ]; then VERDICT=zswap
  fi
  if [ "$WHY" = shrinker ]; then
    say "→ zswap is on, but its shrinker is too: Hatchabot gives agents no swap here (run this script again to turn the shrinker off)."
  elif [ "$WHY" = zram-disk ]; then
    say "→ zram and an uncompressed disk swap, without zswap: Hatchabot gives agents no swap here (turn the disk swap off, or zswap on)."
  elif [ "$VERDICT" = none ]; then
    say "→ No compressed swap: Hatchabot gives agents no swap here."
  else
    say "→ Compressed swap is on ($VERDICT): Hatchabot gives agents their swap allowance here."
  fi
}

# The helper the boot unit runs: re-applies $CONF. Also what `enable` runs now.
# Its paths written into it as they are named above, and this script's own
# path as it was run (SELF), for the journal to name in a fix (HB-1459):
# quoted for sh in an assignment of its own (SELF_Q), since bash before 4.3
# (and BASH_COMPAT=42) reads that substitution inside double quotes its own
# way, and a path with a ' left the helper a quote it never closed.
SELF="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
SELF_Q=${SELF//\'/\'\\\'\'}
HELPER_BODY="#!/bin/sh
# Written by Hatchabot scripts/enable-compressed-swap.sh: re-applies compressed
# swap at boot from $CONF. Undo: that script --undo.
set -u
CONF='$CONF' ZS='$ZS' ZRAM='$ZRAM' SWAPS='$SWAPS' FSTAB='$FSTAB'
SELF='$SELF_Q'
"'. "$CONF"
if [ "$MODE" = zswap ]; then
  modprobe "$COMPRESSOR" 2>/dev/null || true
  [ -w "$ZS/zpool" ] && [ "$(cat $ZS/zpool)" != zsmalloc ] && echo zsmalloc > "$ZS/zpool" 2>/dev/null
  echo "$COMPRESSOR" > "$ZS/compressor" 2>/dev/null || echo "zswap: compressor $COMPRESSOR refused, keeping $(cat $ZS/compressor)" >&2
  echo "$POOL" > "$ZS/max_pool_percent"
  [ -w "$ZS/shrinker_enabled" ] && echo "$SHRINKER" > "$ZS/shrinker_enabled"
  echo Y > "$ZS/enabled"
else
  # zswap goes off only with zram the one swap: a disk swap beside it (one
  # back through fstab since --zram, which refuses one) would be left
  # uncompressed, the state Hatchabot gives agents no swap in (HB-1459). Then
  # zswap is left as it is, and the journal says so and what to do.
  DISK=$(awk '"'"'NR>1 && $1 !~ /^\/dev\/zram[0-9]+$/ {printf "%s%s", (n++ ? " " : ""), $1}'"'"' "$SWAPS")
  if [ -n "$DISK" ] && [ -r "$ZS/enabled" ]; then
    echo "zram: a disk swap is on beside zram ($DISK), so zswap is left as it is (enabled=$(cat "$ZS/enabled")): turned off, that swap would be uncompressed, and Hatchabot gives agents no swap on a machine like that. To fix it, turn that swap off (swapoff $DISK, and take its line out of $FSTAB), or use zswap in front of it instead: sudo $SELF, without --zram." >&2
  elif [ -n "$DISK" ]; then
    echo "zram: a disk swap is on beside zram ($DISK), and this kernel has no zswap to compress in front of it: that swap is uncompressed, and Hatchabot gives agents no swap on a machine like that. To fix it, turn that swap off: swapoff $DISK, and take its line out of $FSTAB." >&2
  else
    [ -w "$ZS/enabled" ] && echo N > "$ZS/enabled"
  fi
  if ! grep -q "^/dev/zram0 " "$SWAPS"; then
    modprobe zram num_devices=1 || { echo "zram: module missing (linux-modules-extra-$(uname -r))" >&2; exit 1; }
    [ "$(cat "$ZRAM/disksize")" = 0 ] || echo 1 > "$ZRAM/reset"
    echo "$COMPRESSOR" > "$ZRAM/comp_algorithm" 2>/dev/null || echo "zram: $COMPRESSOR refused, keeping the default" >&2
    echo "$ZRAM_SIZE" > "$ZRAM/disksize"
    mkswap -L hatchabot-zram /dev/zram0 >/dev/null
    swapon -p 100 /dev/zram0
  fi
fi
'
# helper_state: the installed helper against HELPER_BODY: same; path, when
# only its SELF= line differs (this release's, written from another
# checkout); other (another release's, or none).
helper_state() {
  local have
  have="$(cat "$HELPER" 2>/dev/null)" || { echo other; return 0; }
  if [ "$have" = "$(printf '%s\n' "$HELPER_BODY")" ]; then echo same
  elif [ "$(printf '%s\n' "$have" | grep -v '^SELF=')" = "$(printf '%s\n' "$HELPER_BODY" | grep -v '^SELF=')" ]; then echo path
  else echo other; fi
}
UNIT_BODY="[Unit]
Description=Hatchabot: compressed swap (zswap or zram) for agents
Documentation=https://github.com/hatchabot/hatchabot/blob/main/docs/features.md
After=local-fs.target systemd-modules-load.service swap.target
ConditionPathExists=$CONF

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$HELPER

[Install]
WantedBy=multi-user.target"

if [ "$ACTION" = status ]; then status; exit 0; fi
[ "$(id -u)" = 0 ] || [ "$DRY" = 1 ] || die "run it as root: sudo $0 ${*:-}"

# A compressor the kernel has: zstd (best ratio on agent memory, ~3.6:1 measured), else lz4, else the current.
best_compressor() {
  local c
  for c in zstd lz4; do
    if grep -qx "name *: $c" "$CRYPTO" 2>/dev/null || modprobe -n "$c" 2>/dev/null; then echo "$c"; return; fi
  done
  cat "$ZS/compressor" 2>/dev/null || echo lzo
}

enable() {
  local mem_bytes; mem_bytes=$(awk '/^MemTotal:/ {print $2*1024}' "$MEMINFO")
  local comp; comp=$(best_compressor)
  [ "$comp" = zstd ] || note "zstd is not available here; using $comp (about 2.5:1 instead of 3.6:1 on agent memory)."
  [[ "$POOL" =~ ^[0-9]+$ ]] && [ "$POOL" -ge 5 ] && [ "$POOL" -le 50 ] || die "--pool is a percent from 5 to 50"
  local make_swapfile=0 zram_now='' zram_have=0 ZRAM_BYTES=''
  if [ "$MODE" = zswap ]; then
    [ -d "$ZS" ] || die "this kernel has no zswap; try --zram"
    if [ "$(awk 'NR>1 && $1 !~ /^\/dev\/zram/' "$SWAPS" | wc -l)" = 0 ]; then make_swapfile=1; fi
  else
    # zram turns zswap off, and a disk swap left on beside it is then
    # uncompressed: Hatchabot gives agents no swap there (src/domain/swap.ts,
    # parseSwapProbe), and every agent lost its allowance (HB-1070). Refused
    # before anything changes, with the two ways that work.
    local disk_swaps; disk_swaps="$(awk 'NR>1 && $1 !~ /^\/dev\/zram[0-9]+$/ {printf "%s%s", (n++ ? " " : ""), $1}' "$SWAPS")"
    if [ -n "$disk_swaps" ]; then
      # Set up in zram mode already, the boot helper is the one thing written:
      # one an older release wrote turns zswap off at boot beside such a swap,
      # and this refusal was the only answer a rerun had for it (HB-1459).
      # One that differs only in the script's path is this release's, and
      # says so: it did what the note below says already.
      local helper_was; helper_was="$(helper_state)"
      if [ "$(conf_value "$CONF" MODE)" = zram ] && [ "$helper_was" != same ]; then
        write "$HELPER" "$HELPER_BODY"
        run chmod 0755 "$HELPER"
        if [ "$DRY" = 1 ] && [ "$helper_was" = path ]; then
          say "Dry run: only the script's path in the boot helper would change (to $SELF), and nothing else: --zram needs every disk swap off, and $disk_swaps is on."
        elif [ "$DRY" = 1 ]; then
          say "Dry run: the boot helper would be brought up to date, and nothing else changed: --zram needs every disk swap off, and $disk_swaps is on."
        elif [ "$helper_was" = path ]; then
          say "Only the script's path in the boot helper changed (it names $SELF now); nothing else changed: --zram needs every disk swap off, and $disk_swaps is on."
        else
          say "The boot helper is brought up to date; nothing else changed: --zram needs every disk swap off, and $disk_swaps is on."
          note "At boot it now leaves zswap as it is while a disk swap is on beside zram, and says so in the journal."
        fi
      else
        say "Nothing changed: --zram needs every disk swap off, and $disk_swaps is on."
      fi
      note "zram turns zswap off, so that swap would be uncompressed, and Hatchabot gives agents no swap on a machine like that."
      note "Either:"
      note "• use zswap instead, which compresses in front of that swap: run this again without --zram; or"
      note "• turn the disk swap off first (sudo swapoff $disk_swaps, and take its line out of $FSTAB), then run this again with --zram."
      exit 1
    fi
    if ! modprobe -n zram 2>/dev/null; then
      say "zram needs a kernel module this machine does not have."
      note "On Ubuntu it is in linux-modules-extra-$(uname -r) (cloud images leave it out):"
      note "  sudo apt-get install -y linux-modules-extra-$(uname -r)"
      note "then run this again — or use zswap (no --zram), which is built in."
      exit 1
    fi
    ZRAM_SIZE="${ZRAM_SIZE:-$(( mem_bytes / 2 / 1048576 ))M}"
    ZRAM_BYTES="$(zram_bytes "$ZRAM_SIZE")" || die "--zram-size takes a size such as 8G, 512M or 1.5G (K, M, G or T, counted in 1024s), or a number of bytes: \"$ZRAM_SIZE\" is not one, so nothing was changed."
    # A zram0 already on: the helper uses it as it is. One this script made,
    # at another size than asked for, is made again at that size now, as the
    # header promises; the size was written down and the device kept its old
    # one until the next boot (HB-1112). Compared as the kernel keeps it (in
    # bytes, rounded up to a page). One it did not make is never touched.
    if grep -q '^/dev/zram0 ' "$SWAPS"; then
      zram_have="$(cat "$ZRAM/disksize" 2>/dev/null || echo 0)"
      local SET_MODE PREV_ZRAM0
      SET_MODE="$(conf_value "$CONF" MODE)" PREV_ZRAM0="$(conf_value "$STATE" PREV_ZRAM0)"
      if ours_zram; then
        [ "$ZRAM_BYTES" = "$zram_have" ] || zram_now=resize
      else
        zram_now=theirs
      fi
    fi
  fi

  say "This will turn on compressed swap ($MODE) on $(hostname):"
  if [ "$MODE" = zswap ]; then
    note "• zswap on, compressor $comp, pool zsmalloc, at most $POOL% of memory ($(human $(( mem_bytes * POOL / 100 )))) for compressed pages"
    note "• swapped pages are compressed in memory first; pages that do not compress, and the oldest once that pool is full, go on to the swap file (for nothing on disk, use --zram)"
    if [ "$SHRINKER" = N ]; then
      note "• zswap's shrinker off: cold compressed pages stay in memory instead of being written to the swap file early"
    else
      note "• zswap's shrinker stays on (--keep-shrinker): Hatchabot gives agents no swap while it is"
    fi
    if [ "$make_swapfile" = 1 ]; then
      note "• there is no swap here, and zswap needs a swap device behind it: a $SWAP_SIZE $SWAPFILE is made (and added to $FSTAB)"
    else
      note "• your swap stays as it is: $(awk 'NR>1 {printf "%s ", $1}' "$SWAPS")"
    fi
  elif [ "$zram_now" = resize ]; then
    note "• /dev/zram0, which this script made, holds up to $(human "$zram_have") now: it is switched off (what it holds is read back into memory, which needs that much free memory) and made again holding up to $ZRAM_SIZE before compression, algorithm $comp, priority 100"
  elif [ "$zram_now" = theirs ]; then
    note "• /dev/zram0 is on already, and this script did not make it: it is used as it is ($(human "$zram_have")), so --zram-size does not change it"
  else
    note "• a zram swap device (/dev/zram0) holding up to $ZRAM_SIZE before compression, algorithm $comp, priority 100 (used before any disk swap)"
    note "• zswap off (it would only compress twice); nothing swapped to zram ever reaches the disk"
    note "• your other swap stays as it is"
  fi
  note "• the same at every boot: $UNIT (runs $HELPER, settings in $CONF) — no reboot, no boot-loader edit"
  note "Undo any time: sudo $0 --undo"
  echo
  ask "Go ahead?" || { echo "Nothing changed."; exit 0; }

  # Before anything is written: one that will not go off changes nothing.
  # Off and reset, the helper below makes it again at the new size; until it
  # has, a failure says zram0 is off and how to get it back (zram_left_off).
  if [ "$zram_now" = resize ]; then
    run swapoff /dev/zram0 || die "/dev/zram0 could not be switched off to make it again at $ZRAM_SIZE (above: it needs as much free memory as it holds), so nothing was changed. Free some memory (stop an agent or two), then run this again."
    ZRAM_WAS="$zram_have" ZRAM_OFF=reset
    trap zram_left_off EXIT
    zram_reset
    ZRAM_OFF=made
  fi

  if [ "$make_swapfile" = 1 ]; then
    [ -e "$SWAPFILE" ] && die "$SWAPFILE exists but is not in use; check it, or remove it, and run again"
    run fallocate -l "$SWAP_SIZE" "$SWAPFILE"
    run chmod 600 "$SWAPFILE"
    run mkswap "$SWAPFILE"
    run swapon "$SWAPFILE"
    if ! grep -qE "^$SWAPFILE\s" "$FSTAB"; then
      if [ "$DRY" = 1 ]; then note "would add '$SWAPFILE none swap sw 0 0' to $FSTAB"; else printf '%s none swap sw 0 0\n' "$SWAPFILE" >> "$FSTAB"; fi
    fi
  fi

  # Remember what was here, once, so --undo can put it back. A swap file a
  # later run makes is written down too, the rest left as the first run
  # found it: undo never offered to remove one (HB-1113).
  if [ -f "$STATE" ] && [ "$make_swapfile" = 1 ] && [ "$(conf_value "$STATE" MADE_SWAPFILE)" != 1 ]; then
    write "$STATE" "$(grep -v '^MADE_SWAPFILE=' "$STATE" || true)
MADE_SWAPFILE=1"
  elif [ ! -f "$STATE" ]; then
    write "$STATE" "PREV_ZSWAP_ENABLED=$(cat $ZS/enabled 2>/dev/null || echo N)
PREV_COMPRESSOR=$(cat $ZS/compressor 2>/dev/null || echo lzo)
PREV_ZPOOL=$(cat $ZS/zpool 2>/dev/null || echo)
PREV_POOL=$(cat $ZS/max_pool_percent 2>/dev/null || echo 20)
PREV_SHRINKER=$(cat $ZS/shrinker_enabled 2>/dev/null || echo Y)
PREV_SWAPPINESS=$(cat "$SWAPPINESS_NOW")
PREV_ZRAM0=$(grep -q '^/dev/zram0 ' "$SWAPS" && echo 1 || echo 0)
MADE_SWAPFILE=$make_swapfile"
  fi
  write "$CONF" "# Hatchabot compressed swap (scripts/enable-compressed-swap.sh). Re-applied at boot by $UNIT.
MODE=$MODE
COMPRESSOR=$comp
POOL=$POOL
SHRINKER=$SHRINKER
ZRAM_SIZE=${ZRAM_BYTES:-0}"
  write "$HELPER" "$HELPER_BODY"
  run chmod 0755 "$HELPER"
  # The compressor's module loads before the unit runs.
  write "$MODULES_LOAD" "# Hatchabot compressed swap: the compressor (and zram) at boot
$comp$( [ "$MODE" = zram ] && printf '\nzram' )"
  write "$UNIT_FILE" "$UNIT_BODY"
  run systemctl daemon-reload
  run systemctl enable "$UNIT"
  # Now, not at the next boot.
  run "$HELPER"
  ! grep -q '^/dev/zram0 ' "$SWAPS" || ZRAM_OFF=''

  # vm.swappiness: only with the owner's yes.
  local cur; cur=$(cat "$SWAPPINESS_NOW")
  if [ -z "$SWAPPINESS" ] && [ "$YES" = 0 ] && [ -t 0 ]; then
    echo
    say "One more, optional: vm.swappiness (now $cur)."
    note "It is how readily the kernel moves idle memory into swap rather than dropping file cache."
    note "With compressed swap, swapping is cheap (milliseconds back), so a higher value (100) lets idle"
    note "agents be compressed before useful cache is thrown away. Lower values keep more uncompressed."
    note "Hatchabot works either way; agents only swap within the allowance you give them."
    if ask "Set vm.swappiness to 100 (kept across reboots)?"; then SWAPPINESS=100; fi
  fi
  if [ -n "$SWAPPINESS" ]; then
    [[ "$SWAPPINESS" =~ ^[0-9]+$ ]] && [ "$SWAPPINESS" -le 200 ] || die "--swappiness is 0–200"
    write "$SYSCTL" "# Hatchabot compressed swap (scripts/enable-compressed-swap.sh)
vm.swappiness = $SWAPPINESS"
    run sysctl -q -w "vm.swappiness=$SWAPPINESS"
  fi

  [ "$DRY" = 1 ] && { echo; echo "Dry run: nothing changed."; exit 0; }
  echo
  status
  # Not what it set out to do: said, and not "done" (HB-1070). A shrinker
  # kept on with --keep-shrinker is what was asked for.
  if [ "$VERDICT" = none ] && ! { [ "$WHY" = shrinker ] && [ "$SHRINKER" = Y ]; }; then
    echo
    say "Compressed swap is not on (the line above says why), so there is nothing to set in Hatchabot yet: agents get no swap here."
    note "Fix what that line says and run this again, or put it all back: sudo $0 --undo"
    exit 1
  fi
  echo
  say "Next, in Hatchabot (no rebuild needed; applied to running agents within seconds):"
  note "all agents:  Settings → Hosts → Defaults → Compressed swap per agent → 2g"
  note "one agent:   its sheet → Advanced → Runtime → Compressed swap, or: hatchabot swap <agent> 2g"
  note "check:       hatchabot doctor"
}

# Whether /dev/zram0 is the one the helper made (and so --undo's to switch
# off). Undo switched off any zram0, a distribution's own one too, which was
# there before Hatchabot and is no setting of its own (HB-0281). The helper
# labels its device hatchabot-zram; where the label cannot be read, by what
# was recorded: zram mode, and no zram0 in use before the first run.
ours_zram() {
  grep -q '^/dev/zram0 ' "$SWAPS" || return 1
  local label
  if label="$(blkid -p -s LABEL -o value /dev/zram0 2>/dev/null)"; then [ "$label" = hatchabot-zram ]; return; fi
  [ "$SET_MODE" = zram ] && [ "${PREV_ZRAM0:-0}" != 1 ]
}

# ours_zram_off: /dev/zram0, which this script made (by its label, or by
# what was recorded), off but never reset: an --undo, or a resize, whose reset
# was refused. --undo again resets it.
ours_zram_off() {
  ! grep -q '^/dev/zram0 ' "$SWAPS" || return 1
  [ -r "$ZRAM/disksize" ] && [ "$(cat "$ZRAM/disksize" 2>/dev/null)" != 0 ] || return 1
  local label
  if label="$(blkid -p -s LABEL -o value /dev/zram0 2>/dev/null)"; then [ "$label" = hatchabot-zram ]; return; fi
  [ "$SET_MODE" = zram ] && [ "${PREV_ZRAM0:-0}" != 1 ]
}
# An --undo that stopped at zram0 (UNDO_LEFT: `off` until it is switched off,
# then `reset`) ended with the shell's own words, the boot unit gone, zswap
# not put back and the settings left, and nothing said (review of HB-1112).
UNDO_LEFT=''
undo_left() {
  local rc=$?
  if [ "$rc" = 0 ] || [ -z "$UNDO_LEFT" ]; then return 0; fi
  {
    echo
    if [ "$UNDO_LEFT" = off ]; then
      echo "Error: --undo stopped part-way: the boot unit $UNIT is gone, but /dev/zram0 could not be switched off (above: that needs as much free memory as it holds). It is still on, and zswap, swappiness, the helper and the settings are as they were."
      echo "  Free some memory (stop an agent or two), then run this again: sudo $0 --undo"
    else
      echo "Error: --undo stopped part-way: the boot unit $UNIT is gone and /dev/zram0 is off, but it could not be reset (above: something still holds it). zswap and swappiness are not put back yet, and the helper and the settings are still there."
      echo "  Agents have no compressed swap now. Run this again in a minute, once nothing holds it: sudo $0 --undo"
    fi
  } >&2
  exit 1
}

undo() {
  say "This will undo Hatchabot's compressed swap on $(hostname):"
  local SET_MODE="" OURS_ZRAM=0
  [ -f "$CONF" ] && . "$CONF" && SET_MODE="$MODE"
  [ -f "$STATE" ] && . "$STATE"
  ! ours_zram || OURS_ZRAM=1
  [ "$OURS_ZRAM" = 1 ] || ! ours_zram_off || OURS_ZRAM=2
  note "• the boot unit $UNIT, its helper and settings are removed"
  note "• zswap goes back to enabled=${PREV_ZSWAP_ENABLED:-N}, compressor ${PREV_COMPRESSOR:-lzo}${PREV_ZPOOL:+, zpool $PREV_ZPOOL}, pool ${PREV_POOL:-20}%"
  [ "$OURS_ZRAM" = 1 ] && note "• /dev/zram0 is switched off: what it holds is read back into memory (needs that much free memory)"
  [ "$OURS_ZRAM" = 2 ] && note "• /dev/zram0, which this script made, is off already but was never reset: it is reset"
  [ "$OURS_ZRAM" = 1 ] || ! grep -q '^/dev/zram0 ' "$SWAPS" || note "• /dev/zram0 stays on: Hatchabot did not make it"
  [ -f "$SYSCTL" ] && note "• vm.swappiness back to ${PREV_SWAPPINESS:-60}"
  [ "${MADE_SWAPFILE:-0}" = 1 ] && note "• the $SWAPFILE this script made: you are asked separately"
  note "Agents then run without swap (Hatchabot withholds their allowance within ten minutes, and at once on a start or wake)."
  echo
  ask "Go ahead?" || { echo "Nothing changed."; exit 0; }
  if [ -f "$UNIT_FILE" ]; then
    run systemctl disable "$UNIT" 2>/dev/null || true
    run rm -f "$UNIT_FILE"
    run systemctl daemon-reload
  fi
  if [ "$OURS_ZRAM" != 0 ]; then
    UNDO_LEFT=off
    trap undo_left EXIT
    [ "$OURS_ZRAM" = 2 ] || run swapoff /dev/zram0
    UNDO_LEFT=reset
    zram_reset
    UNDO_LEFT=''
  fi
  if [ -d "$ZS" ]; then
    run sh -c "echo ${PREV_ZSWAP_ENABLED:-N} > $ZS/enabled"
    run sh -c "echo ${PREV_COMPRESSOR:-lzo} > $ZS/compressor" || true
    run sh -c "echo ${PREV_POOL:-20} > $ZS/max_pool_percent"
    [ -n "${PREV_ZPOOL:-}" ] && [ -w "$ZS/zpool" ] && run sh -c "echo $PREV_ZPOOL > $ZS/zpool" 2>/dev/null || true
    [ -w "$ZS/shrinker_enabled" ] && run sh -c "echo ${PREV_SHRINKER:-Y} > $ZS/shrinker_enabled"
  fi
  if [ -f "$SYSCTL" ]; then
    run rm -f "$SYSCTL"
    run sysctl -q -w "vm.swappiness=${PREV_SWAPPINESS:-60}"
  fi
  if [ "${MADE_SWAPFILE:-0}" = 1 ] && grep -q "^$SWAPFILE " "$SWAPS"; then
    if ask "Also remove the $SWAPFILE this script made (its contents are read back into memory first)?"; then
      run swapoff "$SWAPFILE"
      run sed -i "\#^$SWAPFILE\s#d" "$FSTAB"
      run rm -f "$SWAPFILE"
    fi
  fi
  run rm -f "$HELPER" "$CONF" "$STATE" "$MODULES_LOAD"
  run rmdir "$(dirname "$CONF")" 2>/dev/null || true
  [ "$DRY" = 1 ] && { echo "Dry run: nothing changed."; exit 0; }
  echo
  status
}

case "$ACTION" in
  enable) enable ;;
  undo) undo ;;
esac
