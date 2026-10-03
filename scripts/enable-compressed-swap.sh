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
#   --pool PERCENT       zswap: the most memory its compressed pool may take (default 20).
#   --zram-size SIZE     zram: how much it may hold before compression (default: half of memory).
#   --swap-size SIZE     zswap with no swap at all: the size of the /swapfile it makes (default 8G).
#   --swappiness N       also set vm.swappiness (asked otherwise; see below). 0–200.
#   --keep-shrinker      zswap: leave the kernel's shrinker on (it writes cold compressed pages
#                        to the swap file early; off by default here — see below).
#   --yes                answer yes to everything (a provisioner); --swappiness still opt-in.
#   --dry-run            print what it would do, change nothing.
#
# Afterwards, in Hatchabot: Settings → Hosts → Defaults → "Compressed swap per
# agent" (all agents), or an agent's sheet → Advanced → Runtime → Compressed
# swap (one agent), or `hatchabot swap <agent> 2g`. `hatchabot doctor` shows the state.
set -euo pipefail

UNIT=hatchabot-compressed-swap.service
UNIT_FILE=/etc/systemd/system/$UNIT
HELPER=/usr/local/sbin/hatchabot-compressed-swap
CONF=/etc/hatchabot/compressed-swap.conf
STATE=/etc/hatchabot/compressed-swap.state
SYSCTL=/etc/sysctl.d/90-hatchabot-swap.conf
ZS=/sys/module/zswap/parameters

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
bytes_of() { # 8G, 512M, 1.5G → bytes
  local v="${1^^}"; v="${v%B}"
  awk -v v="$v" 'BEGIN { n=v+0; u=substr(v, length(v)); m=(u=="K")?1024:(u=="M")?1048576:(u=="G")?1073741824:(u=="T")?1099511627776:1; printf "%d", n*m }'
}
human() { awk -v b="$1" 'BEGIN { if (b>=1073741824) printf "%.1f GB", b/1073741824; else printf "%d MB", b/1048576 }'; }

[ "$(uname -s)" = Linux ] || die "Linux only. On a Mac, Docker Desktop's VM already compresses memory its own way."

status() {
  say "Compressed swap on $(hostname) (kernel $(uname -r))"
  if [ -d "$ZS" ]; then
    note "zswap: enabled=$(cat $ZS/enabled) compressor=$(cat $ZS/compressor) zpool=$(cat $ZS/zpool 2>/dev/null || echo -) max_pool_percent=$(cat $ZS/max_pool_percent) shrinker=$(cat $ZS/shrinker_enabled 2>/dev/null || echo -)"
    local pool stored
    pool=$(awk '/^Zswap:/ {print $2*1024}' /proc/meminfo); stored=$(awk '/^Zswapped:/ {print $2*1024}' /proc/meminfo)
    if [ -n "$stored" ] && [ "${stored:-0}" -gt 0 ]; then
      note "zswap pool: $(human "$stored") stored in $(human "$pool") ($(awk -v s="$stored" -v p="$pool" 'BEGIN { printf "%.2f", (p>0)?s/p:0 }'):1)"
    else
      note "zswap pool: empty"
    fi
  else
    note "zswap: not in this kernel"
  fi
  local d
  for d in /sys/block/zram*; do
    [ -e "$d/mm_stat" ] || continue
    # mm_stat: orig_data_size compr_data_size mem_used_total …
    read -r orig compr used _ < "$d/mm_stat"
    note "${d##*/}: algorithm $(sed 's/.*\[\(.*\)\].*/\1/' "$d/comp_algorithm") · disksize $(human "$(cat "$d/disksize")") · $(human "$orig") stored in $(human "$used")$( [ "$orig" -gt 1048576 ] && [ "$used" -gt 0 ] && awk -v o="$orig" -v u="$used" 'BEGIN { printf " (%.2f:1)", o/u }')"
  done
  note "swap devices:"; sed 's/^/    /' /proc/swaps
  note "vm.swappiness=$(cat /proc/sys/vm/swappiness)"
  if [ -f "$UNIT_FILE" ]; then
    note "boot unit: $UNIT $(systemctl is-enabled "$UNIT" 2>/dev/null || true) ($(. "$CONF" 2>/dev/null; echo "mode=${MODE:-?}"))"
  else
    note "boot unit: not installed (nothing is re-applied at boot)"
  fi
  local verdict=none
  grep -q '^/dev/zram' /proc/swaps && verdict=zram
  if [ "$verdict" = none ] && [ "$(cat $ZS/enabled 2>/dev/null)" = Y ] && [ "$(awk 'NR>1' /proc/swaps | grep -vc '^/dev/zram' || true)" -gt 0 ]; then verdict=zswap; fi
  if [ "$verdict" = none ]; then
    say "→ No compressed swap: Hatchabot gives agents no swap here."
  else
    say "→ Compressed swap is on ($verdict): Hatchabot gives agents their swap allowance here."
  fi
}

if [ "$ACTION" = status ]; then status; exit 0; fi
[ "$(id -u)" = 0 ] || [ "$DRY" = 1 ] || die "run it as root: sudo $0 ${*:-}"

# The helper the boot unit runs: re-applies $CONF. Also what `enable` runs now.
HELPER_BODY='#!/bin/sh
# Written by Hatchabot scripts/enable-compressed-swap.sh: re-applies compressed
# swap at boot from /etc/hatchabot/compressed-swap.conf. Undo: that script --undo.
set -u
. /etc/hatchabot/compressed-swap.conf
ZS=/sys/module/zswap/parameters
if [ "$MODE" = zswap ]; then
  modprobe "$COMPRESSOR" 2>/dev/null || true
  [ -w "$ZS/zpool" ] && [ "$(cat $ZS/zpool)" != zsmalloc ] && echo zsmalloc > "$ZS/zpool" 2>/dev/null
  echo "$COMPRESSOR" > "$ZS/compressor" 2>/dev/null || echo "zswap: compressor $COMPRESSOR refused, keeping $(cat $ZS/compressor)" >&2
  echo "$POOL" > "$ZS/max_pool_percent"
  [ -w "$ZS/shrinker_enabled" ] && echo "$SHRINKER" > "$ZS/shrinker_enabled"
  echo Y > "$ZS/enabled"
else
  [ -w "$ZS/enabled" ] && echo N > "$ZS/enabled"
  if ! grep -q "^/dev/zram0 " /proc/swaps; then
    modprobe zram num_devices=1 || { echo "zram: module missing (linux-modules-extra-$(uname -r))" >&2; exit 1; }
    [ "$(cat /sys/block/zram0/disksize)" = 0 ] || echo 1 > /sys/block/zram0/reset
    echo "$COMPRESSOR" > /sys/block/zram0/comp_algorithm 2>/dev/null || echo "zram: $COMPRESSOR refused, keeping the default" >&2
    echo "$ZRAM_SIZE" > /sys/block/zram0/disksize
    mkswap -L hatchabot-zram /dev/zram0 >/dev/null
    swapon -p 100 /dev/zram0
  fi
fi
'
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

# A compressor the kernel has: zstd (best ratio on agent memory, ~3.6:1 measured), else lz4, else the current.
best_compressor() {
  local c
  for c in zstd lz4; do
    if grep -qx "name *: $c" /proc/crypto 2>/dev/null || modprobe -n "$c" 2>/dev/null; then echo "$c"; return; fi
  done
  cat "$ZS/compressor" 2>/dev/null || echo lzo
}

enable() {
  local mem_bytes; mem_bytes=$(awk '/^MemTotal:/ {print $2*1024}' /proc/meminfo)
  local comp; comp=$(best_compressor)
  [ "$comp" = zstd ] || note "zstd is not available here; using $comp (about 2.5:1 instead of 3.6:1 on agent memory)."
  [[ "$POOL" =~ ^[0-9]+$ ]] && [ "$POOL" -ge 5 ] && [ "$POOL" -le 50 ] || die "--pool is a percent from 5 to 50"
  local make_swapfile=0
  if [ "$MODE" = zswap ]; then
    [ -d "$ZS" ] || die "this kernel has no zswap; try --zram"
    if [ "$(awk 'NR>1 && $1 !~ /^\/dev\/zram/' /proc/swaps | wc -l)" = 0 ]; then make_swapfile=1; fi
  else
    if ! modprobe -n zram 2>/dev/null; then
      say "zram needs a kernel module this machine does not have."
      note "On Ubuntu it is in linux-modules-extra-$(uname -r) (cloud images leave it out):"
      note "  sudo apt-get install -y linux-modules-extra-$(uname -r)"
      note "then run this again — or use zswap (no --zram), which is built in."
      exit 1
    fi
    ZRAM_SIZE="${ZRAM_SIZE:-$(( mem_bytes / 2 / 1048576 ))M}"
  fi

  say "This will turn on compressed swap ($MODE) on $(hostname):"
  if [ "$MODE" = zswap ]; then
    note "• zswap on, compressor $comp, pool zsmalloc, at most $POOL% of memory ($(human $(( mem_bytes * POOL / 100 )))) for compressed pages"
    note "• swapped pages are compressed in memory first; only when that pool is full do the oldest go on to the swap file"
    [ "$SHRINKER" = N ] && note "• zswap's shrinker off: cold compressed pages stay in memory instead of being written to the swap file early"
    if [ "$make_swapfile" = 1 ]; then
      note "• there is no swap here, and zswap needs a swap device behind it: a $SWAP_SIZE /swapfile is made (and added to /etc/fstab)"
    else
      note "• your swap stays as it is: $(awk 'NR>1 {printf "%s ", $1}' /proc/swaps)"
    fi
  else
    note "• a zram swap device (/dev/zram0) holding up to $ZRAM_SIZE before compression, algorithm $comp, priority 100 (used before any disk swap)"
    note "• zswap off (it would only compress twice); nothing swapped to zram ever reaches the disk"
    note "• your other swap stays as it is"
  fi
  note "• the same at every boot: $UNIT (runs $HELPER, settings in $CONF) — no reboot, no boot-loader edit"
  note "Undo any time: sudo $0 --undo"
  echo
  ask "Go ahead?" || { echo "Nothing changed."; exit 0; }

  if [ "$make_swapfile" = 1 ]; then
    [ -e /swapfile ] && die "/swapfile exists but is not in use; check it, or remove it, and run again"
    run fallocate -l "$SWAP_SIZE" /swapfile
    run chmod 600 /swapfile
    run mkswap /swapfile
    run swapon /swapfile
    if ! grep -qE '^/swapfile\s' /etc/fstab; then
      if [ "$DRY" = 1 ]; then note "would add '/swapfile none swap sw 0 0' to /etc/fstab"; else printf '/swapfile none swap sw 0 0\n' >> /etc/fstab; fi
    fi
  fi

  # Remember what was here, once, so --undo can put it back.
  if [ ! -f "$STATE" ]; then
    write "$STATE" "PREV_ZSWAP_ENABLED=$(cat $ZS/enabled 2>/dev/null || echo N)
PREV_COMPRESSOR=$(cat $ZS/compressor 2>/dev/null || echo lzo)
PREV_ZPOOL=$(cat $ZS/zpool 2>/dev/null || echo)
PREV_POOL=$(cat $ZS/max_pool_percent 2>/dev/null || echo 20)
PREV_SHRINKER=$(cat $ZS/shrinker_enabled 2>/dev/null || echo Y)
PREV_SWAPPINESS=$(cat /proc/sys/vm/swappiness)
MADE_SWAPFILE=$make_swapfile"
  fi
  write "$CONF" "# Hatchabot compressed swap (scripts/enable-compressed-swap.sh). Re-applied at boot by $UNIT.
MODE=$MODE
COMPRESSOR=$comp
POOL=$POOL
SHRINKER=$SHRINKER
ZRAM_SIZE=${ZRAM_SIZE:-0}"
  write "$HELPER" "$HELPER_BODY"
  run chmod 0755 "$HELPER"
  # The compressor's module loads before the unit runs.
  write /etc/modules-load.d/hatchabot-compressed-swap.conf "# Hatchabot compressed swap: the compressor (and zram) at boot
$comp$( [ "$MODE" = zram ] && printf '\nzram' )"
  write "$UNIT_FILE" "$UNIT_BODY"
  run systemctl daemon-reload
  run systemctl enable "$UNIT"
  # Now, not at the next boot.
  run "$HELPER"

  # vm.swappiness: only with the owner's yes.
  local cur; cur=$(cat /proc/sys/vm/swappiness)
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
  echo
  say "Next, in Hatchabot (no rebuild needed; applied to running agents within seconds):"
  note "all agents:  Settings → Hosts → Defaults → Compressed swap per agent → 2g"
  note "one agent:   its sheet → Advanced → Runtime → Compressed swap, or: hatchabot swap <agent> 2g"
  note "check:       hatchabot doctor"
}

undo() {
  say "This will undo Hatchabot's compressed swap on $(hostname):"
  [ -f "$CONF" ] && . "$CONF"
  [ -f "$STATE" ] && . "$STATE"
  note "• the boot unit $UNIT, its helper and settings are removed"
  note "• zswap goes back to enabled=${PREV_ZSWAP_ENABLED:-N}, compressor ${PREV_COMPRESSOR:-lzo}${PREV_ZPOOL:+, zpool $PREV_ZPOOL}, pool ${PREV_POOL:-20}%"
  grep -q '^/dev/zram0 ' /proc/swaps && note "• /dev/zram0 is switched off: what it holds is read back into memory (needs that much free memory)"
  [ -f "$SYSCTL" ] && note "• vm.swappiness back to ${PREV_SWAPPINESS:-60}"
  [ "${MADE_SWAPFILE:-0}" = 1 ] && note "• the /swapfile this script made: you are asked separately"
  note "Agents then run without swap (Hatchabot withholds their allowance within ten minutes, and at once on a start or wake)."
  echo
  ask "Go ahead?" || { echo "Nothing changed."; exit 0; }
  if [ -f "$UNIT_FILE" ]; then
    run systemctl disable "$UNIT" 2>/dev/null || true
    run rm -f "$UNIT_FILE"
    run systemctl daemon-reload
  fi
  if grep -q '^/dev/zram0 ' /proc/swaps; then
    run swapoff /dev/zram0
    run sh -c 'echo 1 > /sys/block/zram0/reset'
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
  if [ "${MADE_SWAPFILE:-0}" = 1 ] && grep -q '^/swapfile ' /proc/swaps; then
    if ask "Also remove the /swapfile this script made (its contents are read back into memory first)?"; then
      run swapoff /swapfile
      run sed -i '\#^/swapfile\s#d' /etc/fstab
      run rm -f /swapfile
    fi
  fi
  run rm -f "$HELPER" "$CONF" "$STATE" /etc/modules-load.d/hatchabot-compressed-swap.conf
  run rmdir /etc/hatchabot 2>/dev/null || true
  [ "$DRY" = 1 ] && { echo "Dry run: nothing changed."; exit 0; }
  echo
  status
}

case "$ACTION" in
  enable) enable ;;
  undo) undo ;;
esac
