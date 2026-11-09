#!/usr/bin/env bash
# Keep THIS machine's production install on the newest release tag.
#
#   scripts/follow-latest.sh             # deploy the newest tag if prod is behind
#   scripts/follow-latest.sh --install   # run it every 10 minutes (systemd --user timer)
#   scripts/follow-latest.sh --uninstall
#
# Tagging makes a release `latest`; new installs still take `stable`, which moves
# only with promote.sh. This is for the machine you develop on: it runs every
# release first, so a bad one surfaces here before anyone else can install it.
#
# Deploys go through deploy-release.sh — health check and automatic rollback.
# A tag that failed is remembered and not retried; the next tag clears it.
# From v2.159.0 a tag is deployed only once it is a published, immutable
# GitHub release whose release-manifest.json names that tag's commit.
set -euo pipefail
PROD="${HATCHABOT_PROD_DIR:-$HOME/hatchabot-prod}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/hatchabot"
UNITS="$HOME/.config/systemd/user"
NAME=hatchabot-follow-latest

if [ "${1:-}" = --install ]; then
  mkdir -p "$UNITS"
  # Quoted whole, as install-service.sh writes it: unquoted, a space in a path split it (audit #044).
  # Not found here, refused rather than guessed into the unit (HB-0042).
  NODE_BIN="$(command -v node)" || { echo "node not found on PATH — run this from a shell where 'node --version' works." >&2; exit 1; }
  DOCKER_BIN="$(command -v docker)" || { echo "docker not found on PATH — run this from a shell where 'docker version' works." >&2; exit 1; }
  UNIT_PATH="$(dirname "$NODE_BIN"):$(dirname "$DOCKER_BIN"):/usr/local/bin:/usr/bin:/bin"
  # In quotes as systemd reads them: a backslash or quote escaped, % doubled,
  # and $ doubled in ExecStart. Unquoted, a production folder with a space was
  # cut at the space, and every tick looked for a checkout that is not there
  # (HB-0546).
  . "$(dirname "$0")/systemd-quote.sh"
  cat > "$UNITS/$NAME.service" <<EOF
[Unit]
Description=Hatchabot: deploy the newest release tag to this machine

[Service]
Type=oneshot
Environment="HATCHABOT_PROD_DIR=$(systemd_quoted "$PROD")"
Environment="PATH=$(systemd_quoted "$UNIT_PATH")"
ExecStart=/usr/bin/env bash "$(systemd_arg "$PROD")/scripts/follow-latest.sh"
EOF
  cat > "$UNITS/$NAME.timer" <<EOF
[Unit]
Description=Hatchabot: check for a newer release every 10 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$NAME.timer"
  echo "This machine now follows the newest release. Logs: journalctl --user -u $NAME"
  echo "Stop with: $0 --uninstall"
  exit 0
fi
if [ "${1:-}" = --uninstall ]; then
  systemctl --user disable --now "$NAME.timer" 2>/dev/null || true
  rm -f "$UNITS/$NAME.service" "$UNITS/$NAME.timer"
  systemctl --user daemon-reload
  echo "Stopped following the newest release. Deploy by hand with deploy-release.sh."
  exit 0
fi

# A deploy checks out a new tag in $PROD, replacing this very file while bash is
# still reading it. Run from a private copy. One it cannot make (a full disk)
# ended the tick under set -e with no word and no wait (fourteenth review): it
# reads this file as it is, which nothing changes until a repair or a deploy,
# and stops before either with the try counted as the disk's (disk_stop).
NO_COPY=0
if [ -z "${FOLLOW_LATEST_COPY:-}" ]; then
  tmp=""
  if tmp="$(mktemp 2>/dev/null)" && cp "$0" "$tmp" 2>/dev/null; then
    FOLLOW_LATEST_COPY="$tmp" FOLLOW_LATEST_HOME="$(cd "$(dirname "$0")" && pwd)" exec bash "$tmp" "$@"
  fi
  [ -z "$tmp" ] || rm -f "$tmp" 2>/dev/null || true
  NO_COPY=1
fi
trap '[ -z "${FOLLOW_LATEST_COPY:-}" ] || rm -f "$FOLLOW_LATEST_COPY"' EXIT

[ -d "$PROD/.git" ] || { echo "No production checkout at $PROD."; exit 1; }
mkdir -p "$STATE"
git -C "$PROD" fetch --tags --force --quiet origin
NEWEST="$(git -C "$PROD" tag -l 'v[0-9]*' --sort=-v:refname | grep -vE -- '-(rc|beta|alpha)' | sed -n 1p)"
[ -n "$NEWEST" ] || exit 0
CUR="$(git -C "$PROD" describe --tags --exact-match 2>/dev/null || true)"
# A deploy killed part-way (SIGKILL, a power cut) left prod on the new tag
# with half its dependencies, and its record beside the lock (the one
# deploy-release.sh keys on prod's path): the deploy repairs that first, so
# it runs though prod is on the newest tag already (HB-0266).
CUT="$STATE/upgrade-$(cd "$PROD" && printf %s "$PWD" | cksum | cut -d' ' -f1).from"
[ "$CUR" = "$NEWEST" ] && [ ! -f "$CUT" ] && exit 0
# Only ever forward: a checkout that is ahead (a hand deploy of a newer tag) stays.
vernewer() { printf '%s\n%s\n' "$1" "$2" | sed 's/-/~/' | sort -V | tail -1 | sed 's/~/-/'; }
if [ ! -f "$CUT" ] && [ -n "$CUR" ] && [ "$CUR" != "$NEWEST" ] && [ "$(vernewer "$CUR" "$NEWEST")" = "$CUR" ]; then exit 0; fi
# A tag whose install keeps failing waits longer each time, then is set aside;
# a full disk waits the same way, never counted against it: the try record
# (scripts/follow-tries.sh, shared with follow-channel.sh), read beside where
# this ran from, before a deploy replaces it.
# Missing or unreadable, it must not stop the tick before the repair (fifth
# review): stand-ins that count nothing.
TRIES_HELPER="${FOLLOW_LATEST_HOME:-$(dirname "$0")}/follow-tries.sh"
if ! { [ -r "$TRIES_HELPER" ] && . "$TRIES_HELPER" && declare -F tries_open tries_waiting note_try forget_tries >/dev/null; }; then
  echo "Could not read $TRIES_HELPER: this tick keeps no count of its tries, and tries the deploy."
  MAX_TRIES=8
  tries_open() { T_COUNT=0; T_LAST=0; T_DISK=0; }
  tries_waiting() { return 1; }
  note_try() { :; }
  forget_tries() { :; }
fi
tries_open "$STATE/follow-latest-tries" hatchabot-follow-latest-tries "$NEWEST"
# disk_stop WHAT: a file of this tick's own it could not write (a full disk):
# said, and counted as a try the disk failed, so the next ticks wait; under
# set -e it ended the tick with no word, and every tick tried again
# (fourteenth review). Before a repair or a deploy changes anything.
disk_stop() {
  echo "Could not write $1 (a full disk?), so this tick stops before changing anything. This does not count against $NEWEST; the next ticks wait."
  note_try 1
  exit 1
}
# disk_waiting: 0 while the wait after the disk's last failure lasts, as
# tries_waiting has it for the disk's alone (an hour at most), whatever the
# tag's own: a repair puts back the release that was serving, and waits for
# room only. A repair the disk stopped (5) was not counted, and ran again on
# every tick while the disk stayed full (fifteenth review).
disk_waiting() { [ "$T_DISK" -gt 0 ] && ( T_COUNT="$T_DISK"; tries_waiting ); }
# disk_words TEXT: upgrade.sh's, the list its said_kind reads, a copy
# (test/nightScripts.test.ts holds them equal): this runs from a copy of
# itself, and reads nothing of the release's before its deploy script.
disk_words() {
  case "$1" in
    *[Nn]"o space left on device"*|*[Dd]"isk quota"*|*EDQUOT*) return 0 ;;
    *"file watchers"*) return 1 ;;
    *ENOSPC*) return 0 ;;
  esac
  return 1
}
# A killed deploy put back without the newest tag's code: by the deploy script
# of the release it came from, which was serving here, and which puts that
# release back first and then installs it again. Two cases (HB-0372): the
# newest tag cannot be deployed now (verify_release, below; refused, every
# tick failed with no repair), or the release it came from is at or ahead of
# the newest tag (a hand deploy between two rcs; going on would take it back).
CUT_FROM=""; [ ! -f "$CUT" ] || CUT_FROM="$(sed -n 's/^from //p' "$CUT" | sed -n 1p)"
repair_cut() {
  local deploy rc=0
  echo "A deploy of $PROD was cut off part-way; putting ${CUT_FROM:-the previous release} back."
  [ "$NO_COPY" = 0 ] || disk_stop "a private copy of $0 in ${TMPDIR:-/tmp}"
  deploy="$(mktemp 2>/dev/null)" || disk_stop "a copy of the deploy script in ${TMPDIR:-/tmp}"
  if ! git -C "$PROD" show "$CUT_FROM:scripts/deploy-release.sh" > "$deploy" 2>/dev/null; then
    rm -f "$deploy"; echo "Could not read that release's deploy script. Deploy a release by hand: scripts/deploy-release.sh vX.Y.Z"; return 1
  fi
  HATCHABOT_FOLLOW_KNOWS_5=1 HATCHABOT_PROD_DIR="$PROD" bash "$deploy" "$CUT_FROM" || rc=$?
  rm -f "$deploy"
  # 4: a deploy or upgrade holds the lock, and repairs it first. Routine, as
  # follow-channel.sh has it (tenth review). 5: the machine's disk, or a
  # folder it cannot write: a try the disk failed, so the next repair waits
  # (disk_waiting), never counted against the tag.
  if [ "$rc" = 4 ]; then echo "Another deploy or upgrade of $PROD is running; it puts ${CUT_FROM:-the previous release} back, or the next tick does."; rc=0; fi
  if [ "$rc" = 5 ]; then
    note_try 1
    # Counted here as well: a try this tick counts after it (a tag not yet
    # published) writes the record from these, and wrote over this one.
    T_COUNT=$((T_COUNT + 1)); T_DISK=$((T_DISK + 1)); T_LAST="$(date +%s)"
    echo "Putting ${CUT_FROM:-the previous release} back could not go ahead on this machine's disk (see above); it will be tried again later. This does not count against $NEWEST."
  fi
  return "$rc"
}
if [ -n "$CUT_FROM" ] && [ "$(vernewer "$CUT_FROM" "$NEWEST")" = "$CUT_FROM" ]; then
  ! disk_waiting || exit 0
  repair_cut || exit 1
  exit 0
fi
# A tag set aside stays aside, but not with a killed deploy to repair: the
# deploy repairs that and then tries the tag once more (aside again if it
# still does not start).
FAILED="$STATE/follow-latest-failed"
if [ ! -f "$CUT" ] && [ "$(cat "$FAILED" 2>/dev/null)" = "$NEWEST" ]; then exit 0; fi
# With a killed deploy to repair, the wait is the disk's alone (disk_waiting).
if [ -f "$CUT" ]; then ! disk_waiting || exit 0; else ! tries_waiting || exit 0; fi
# set_aside RELEASE SAID AFTER: RELEASE is not tried again (FAILED names it)
# and its record of tries goes; SAID and AFTER are said. FAILED is written
# whole or not at all, and never ends the tick: `>` on a full disk left it cut
# short, and under set -e ended the tick before anything was counted, so the
# next tick ran the release again at once (thirteenth review). Not written,
# the try is counted instead, so the next ones still wait.
set_aside() {
  if { printf '%s\n' "$1" > "$FAILED.tmp" && mv -f "$FAILED.tmp" "$FAILED"; } 2>/dev/null; then
    forget_tries
    echo "$2 $3"
  else
    rm -f "$FAILED.tmp" 2>/dev/null || true
    echo "$2 Could not write $FAILED to set $1 aside (a full disk?): this try is counted instead, so the next ones wait."
    note_try 0
  fi
}

# ---- Only a release the release workflow published (#37) ----
# A tag alone proves nothing: anyone who could push one would have its
# deploy-release.sh run here. From v2.159.0 every release is published by the
# release workflow (docs/release-by-workflow-design.md) as an immutable GitHub
# release carrying release-manifest.json, which names the commit it was built
# from. So before any of the tag's code runs: the release is published and
# immutable, and its manifest is for this tag and this tag's commit. Older
# tags (made before manifests) are deployed as before. Read without a token:
# at one look per ten minutes the API's limit is far away.
SLUG="${HATCHABOT_SLUG:-hatchabot/hatchabot}"
# verify_release TAG: 0 verified, or made before manifests; 20 not a published
# release (yet); 30 refused; 40 could not check. Says why in $WHY.
verify_release() {
  local tag="$1" dir code commit rc=0
  WHY=""
  [ "$(vernewer "$tag" v2.159.0)" = "$tag" ] || return 0
  dir="$(mktemp -d 2>/dev/null)" || disk_stop "a folder for GitHub's answer in ${TMPDIR:-/tmp}"
  code="$(curl -sS --max-time 30 -o "$dir/release.json" -w '%{http_code}' \
    -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$SLUG/releases/tags/$tag" 2>"$dir/err")" || rc=$?
  if [ "$rc" != 0 ] || { [ "$code" != 200 ] && [ "$code" != 404 ]; }; then
    WHY="GitHub did not answer about its release (${code:-no answer}$( [ -s "$dir/err" ] && printf ': %s' "$(head -c 200 "$dir/err")"))"
    rm -rf "$dir"; return 40
  fi
  if [ "$code" = 404 ]; then WHY="it is not a published release on GitHub"; rm -rf "$dir"; return 20; fi
  if ! commit="$(git -C "$PROD" rev-parse --verify --quiet "$tag^{commit}")"; then
    WHY="its tag names no commit here"; rm -rf "$dir"; return 30
  fi
  # check MODE FILE: the release (published, immutable, carries the manifest)
  # or the manifest (this tag, this version, this commit). 0 yes, 2 not yet, 1 no.
  check() {
    node - "$1" "$2" "$tag" "$commit" <<'JS'
const [mode, file, tag, commit] = process.argv.slice(2);
const no = (why, code = 1) => { console.log(why); process.exit(code); };
let j;
try { j = JSON.parse(require('fs').readFileSync(file, 'utf8')); } catch { no(`its ${mode === 'release' ? 'release' : 'release-manifest.json'} is not readable JSON`); }
if (!j || typeof j !== 'object') no(`its ${mode} is not a JSON object`);
if (mode === 'release') {
  if (j.tag_name !== tag) no(`GitHub's answer is about ${JSON.stringify(j.tag_name)}, not ${tag}`);
  if (j.draft) no('its release is still a draft', 2);
  if (j.immutable !== true) no('its release is not immutable, so what it vouches for could still change');
  if (!(j.assets ?? []).some((a) => a && a.name === 'release-manifest.json')) no('its release has no release-manifest.json');
} else {
  if (j.schema !== 1) no(`its release-manifest.json has schema ${JSON.stringify(j.schema)}, not 1`);
  if (j.tag !== tag || j.version !== tag.slice(1)) no(`its release-manifest.json is for ${JSON.stringify(j.tag)} (${JSON.stringify(j.version)}), not ${tag}`);
  if (j.commit !== commit) no(`its release-manifest.json was built from ${String(j.commit).slice(0, 40)}, but the tag here is ${commit}`);
}
JS
  }
  WHY="$(check release "$dir/release.json")" || rc=$?
  if [ "$rc" = 0 ]; then
    code="$(curl -sSL --max-time 60 --max-filesize 65536 -o "$dir/manifest.json" -w '%{http_code}' \
      "https://github.com/$SLUG/releases/download/$tag/release-manifest.json" 2>"$dir/err")" || rc=$?
    if [ "$rc" != 0 ] || { [ "$code" != 200 ] && [ "$code" != 404 ]; }; then
      WHY="its release-manifest.json could not be fetched (${code:-no answer})"; rm -rf "$dir"; return 40
    fi
    # Listed on an immutable release, yet not there: it never will be.
    [ "$code" = 200 ] || { WHY="its release-manifest.json is listed but not there"; rm -rf "$dir"; return 30; }
    WHY="$(check manifest "$dir/manifest.json")" || rc=$?
  fi
  rm -rf "$dir"
  case "$rc" in 0) return 0 ;; 2) return 20 ;; *) return 30 ;; esac
}
vrc=0; verify_release "$NEWEST" || vrc=$?
if [ "$vrc" != 0 ] && [ -f "$CUT" ]; then repair_cut || echo "The repair did not finish (above); it will be tried again."; fi
case "$vrc" in
  0) ;;
  20)
    # A release is published a few minutes after its tag. One that stays
    # unpublished is looked at less and less often, then set aside.
    if [ $((T_COUNT + 1 - T_DISK)) -ge "$MAX_TRIES" ]; then
      set_aside "$NEWEST" "Not deploying $NEWEST: $WHY, $MAX_TRIES times in a row." "It will not be looked at again; the next tag will be."
    else
      note_try 0
      echo "Not deploying $NEWEST yet: $WHY. Looking again later ($((T_COUNT + 1 - T_DISK)) of $MAX_TRIES)."
    fi
    exit 1 ;;
  30)
    set_aside "$NEWEST" "Not deploying $NEWEST: $WHY. None of its code was run." "It will not be retried; the next tag will be."
    exit 1 ;;
  *)
    echo "Not deploying $NEWEST yet: $WHY. Trying again next time."
    exit 1 ;;
esac

# The deploy script as the NEW release ships it, from a copy for the same reason.
# HATCHABOT_FOLLOW_KNOWS_5: this timer reads 5 (below); a deploy says 5 only to
# a caller that says so, since the timer running it is the release before's,
# and one from before 5 tried every tick on it (seventh review).
[ "$NO_COPY" = 0 ] || disk_stop "a private copy of $0 in ${TMPDIR:-/tmp}"
deploy="$(mktemp 2>/dev/null)" || disk_stop "a copy of the deploy script in ${TMPDIR:-/tmp}"
if ! err="$(git -C "$PROD" show "$NEWEST:scripts/deploy-release.sh" 2>&1 > "$deploy")"; then
  rm -f "$deploy"
  # The disk's words as said_kind reads them (disk_words), and a write that
  # came up short: its own list missed EDQUOT and a bare ENOSPC (fifteenth review).
  if disk_words "$err"; then disk_stop "a copy of the deploy script in ${TMPDIR:-/tmp} ($err)"; fi
  case "$err" in *[Ww]"rite error"*|*[Uu]"nable to write"*) disk_stop "a copy of the deploy script in ${TMPDIR:-/tmp} ($err)" ;; esac
  echo "Could not read the deploy script $NEWEST ships: ${err:-git said nothing}. Trying again next time."
  exit 1
fi
echo "Following latest: ${CUR:-untagged} → $NEWEST"
if HATCHABOT_FOLLOW_KNOWS_5=1 HATCHABOT_PROD_DIR="$PROD" bash "$deploy" "$NEWEST"; then
  rm -f "$FAILED" "$deploy"; forget_tries
else
  rc=$?
  rm -f "$deploy"
  # Exit 1 = the release did not start and was rolled back: set aside at once.
  # 3 = the install step failed: tried again, less and less often. 5 = this
  # machine's disk (full, or a folder it cannot write): tried again the same
  # way, never set aside for it. 2 = refused (a stray file in prod): tried
  # again next time. 4 = a deploy or upgrade was running: routine, the tick
  # ends 0 and counts nothing, as follow-channel.sh's does (tenth review).
  if [ "$rc" = 4 ]; then
    echo "Another deploy or upgrade of $PROD is running; this tick leaves $NEWEST to it, or to the next tick."
    exit 0
  elif [ "$rc" = 1 ]; then
    set_aside "$NEWEST" "Deploying $NEWEST failed and was rolled back." "It will not be retried; the next tag will be."
  elif [ "$rc" = 3 ] && [ $((T_COUNT + 1 - T_DISK)) -ge "$MAX_TRIES" ]; then
    set_aside "$NEWEST" "Deploying $NEWEST did not complete $MAX_TRIES times in a row." "It will not be retried; the next tag will be."
  elif [ "$rc" = 3 ]; then
    note_try 0
    echo "Deploying $NEWEST did not complete (see above); it will be tried again later ($((T_COUNT + 1 - T_DISK)) of $MAX_TRIES)."
  elif [ "$rc" = 5 ]; then
    note_try 1
    echo "Deploying $NEWEST could not go ahead on this machine's disk (see above); it will be tried again later. This does not count against $NEWEST."
  else
    echo "Deploying $NEWEST did not complete (see above); it will be tried again."
  fi
  exit 1
fi
