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
  cat > "$UNITS/$NAME.service" <<EOF
[Unit]
Description=Hatchabot: deploy the newest release tag to this machine

[Service]
Type=oneshot
Environment=HATCHABOT_PROD_DIR=$PROD
Environment="PATH=$(printf '%s' "$UNIT_PATH" | sed -e 's/[\\"]/\\&/g' -e 's/%/%%/g')"
ExecStart=/usr/bin/env bash "$PROD/scripts/follow-latest.sh"
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
# still reading it. Run from a private copy.
if [ -z "${FOLLOW_LATEST_COPY:-}" ]; then
  tmp="$(mktemp)"; cp "$0" "$tmp"
  FOLLOW_LATEST_COPY="$tmp" exec bash "$tmp" "$@"
fi
trap 'rm -f "$FOLLOW_LATEST_COPY"' EXIT

[ -d "$PROD/.git" ] || { echo "No production checkout at $PROD."; exit 1; }
mkdir -p "$STATE"
git -C "$PROD" fetch --tags --force --quiet origin
NEWEST="$(git -C "$PROD" tag -l 'v[0-9]*' --sort=-v:refname | grep -vE -- '-(rc|beta|alpha)' | sed -n 1p)"
[ -n "$NEWEST" ] || exit 0
CUR="$(git -C "$PROD" describe --tags --exact-match 2>/dev/null || true)"
[ "$CUR" = "$NEWEST" ] && exit 0
# Only ever forward: a checkout that is ahead (a hand deploy of a newer tag) stays.
vernewer() { printf '%s\n%s\n' "$1" "$2" | sed 's/-/~/' | sort -V | tail -1 | sed 's/~/-/'; }
if [ -n "$CUR" ] && [ "$(vernewer "$CUR" "$NEWEST")" = "$CUR" ]; then exit 0; fi
if [ "$(cat "$STATE/follow-latest-failed" 2>/dev/null)" = "$NEWEST" ]; then exit 0; fi
# A tag whose install keeps failing (exit 3) is not tried every ten minutes
# for ever: after each failure in a row the wait doubles (10 min, 20, 40 … a
# day at most), and after MAX_TRIES it is set aside like a tag that did not
# start (review, 2026-10-09). "<tag> <failures> <epoch>".
TRIES="$STATE/follow-latest-tries"; MAX_TRIES=8
T_TARGET=""; T_COUNT=0; T_LAST=0
{ read -r T_TARGET T_COUNT T_LAST < "$TRIES"; } 2>/dev/null || true
case "${T_COUNT:-}${T_LAST:-}" in ''|*[!0-9]*) T_COUNT=0; T_LAST=0 ;; esac
if [ "$T_TARGET" = "$NEWEST" ] && [ "$T_COUNT" -gt 0 ]; then
  WAIT=$(( 10 * (1 << (T_COUNT - 1)) - 5 ))   # minutes, less 5 for the timer's own jitter: 5, 15, 35 …
  [ "$WAIT" -le 1440 ] || WAIT=1440
  [ $(( $(date +%s) - T_LAST )) -ge $(( WAIT * 60 )) ] || exit 0
else
  T_COUNT=0
fi

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
  dir="$(mktemp -d)"
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
case "$vrc" in
  0) ;;
  20)
    # A release is published a few minutes after its tag. One that stays
    # unpublished is looked at less and less often, then set aside.
    if [ $((T_COUNT + 1)) -ge "$MAX_TRIES" ]; then
      echo "$NEWEST" > "$STATE/follow-latest-failed"; rm -f "$TRIES"
      echo "Not deploying $NEWEST: $WHY, $MAX_TRIES times in a row. It will not be looked at again; the next tag will be."
    else
      echo "$NEWEST $((T_COUNT + 1)) $(date +%s)" > "$TRIES"
      echo "Not deploying $NEWEST yet: $WHY. Looking again later ($((T_COUNT + 1)) of $MAX_TRIES)."
    fi
    exit 1 ;;
  30)
    echo "$NEWEST" > "$STATE/follow-latest-failed"; rm -f "$TRIES"
    echo "Not deploying $NEWEST: $WHY. None of its code was run. It will not be retried; the next tag will be."
    exit 1 ;;
  *)
    echo "Not deploying $NEWEST yet: $WHY. Trying again next time."
    exit 1 ;;
esac

# The deploy script as the NEW release ships it, from a copy for the same reason.
deploy="$(mktemp)"
git -C "$PROD" show "$NEWEST:scripts/deploy-release.sh" > "$deploy"
echo "Following latest: ${CUR:-untagged} → $NEWEST"
if HATCHABOT_PROD_DIR="$PROD" bash "$deploy" "$NEWEST"; then
  rm -f "$STATE/follow-latest-failed" "$TRIES" "$deploy"
else
  rc=$?
  rm -f "$deploy"
  # Exit 1 = the release did not start and was rolled back: set aside at once.
  # 3 = the install step failed: tried again, less and less often. 2 = refused
  # (a stray file in prod), 4 = a deploy was running: tried again next time.
  if [ "$rc" = 1 ]; then
    echo "$NEWEST" > "$STATE/follow-latest-failed"; rm -f "$TRIES"
    echo "Deploying $NEWEST failed and was rolled back. It will not be retried; the next tag will be."
  elif [ "$rc" = 3 ] && [ $((T_COUNT + 1)) -ge "$MAX_TRIES" ]; then
    echo "$NEWEST" > "$STATE/follow-latest-failed"; rm -f "$TRIES"
    echo "Deploying $NEWEST did not complete $MAX_TRIES times in a row. It will not be retried; the next tag will be."
  elif [ "$rc" = 3 ]; then
    echo "$NEWEST $((T_COUNT + 1)) $(date +%s)" > "$TRIES"
    echo "Deploying $NEWEST did not complete (see above); it will be tried again later ($((T_COUNT + 1)) of $MAX_TRIES)."
  else
    echo "Deploying $NEWEST did not complete (see above); it will be tried again."
  fi
  exit 1
fi
