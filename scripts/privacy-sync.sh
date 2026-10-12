#!/usr/bin/env bash
# Keep GitHub's copy of the privacy fingerprints current: the keyed
# fingerprints of this install's private values (a new agent, a new person)
# that CI's `privacy` job and the privacy watch check against
# (scripts/privacy-ci.mjs; docs/releasing.md, "The privacy check").
#
#   scripts/privacy-sync.sh              # sync now (privacy-check.mjs --sync-ci)
#   scripts/privacy-sync.sh --install    # once a day (systemd --user timer; Linux)
#   scripts/privacy-sync.sh --install --also owner/site   # …and to another repository too
#   scripts/privacy-sync.sh --uninstall
#
# A Mac has no timer here: run `node scripts/privacy-check.mjs --sync-ci`
# after adding an agent or a person, and before each release. It needs this
# machine's install and `gh` signed in with rights to the repository's
# secrets; the value goes to gh on stdin and only counts are printed.
# --also (repeatable) adds a repository whose own privacy job uses the same
# fingerprints, such as the project's website (2026-10-11).
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$PWD"
UNITS="$HOME/.config/systemd/user"
NAME=hatchabot-privacy-sync

ALSO=()
if [ "${1:-}" = --install ]; then
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --also) [[ "${2:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "--also takes a repository as owner/name"; exit 2; }; ALSO+=("$2"); shift 2 ;;
      *) echo "unknown option $1 (scripts/privacy-sync.sh --install [--also owner/name]...)"; exit 2 ;;
    esac
  done
  command -v systemctl >/dev/null 2>&1 || { echo "This needs systemd (Linux). On a Mac, run 'node scripts/privacy-check.mjs --sync-ci' after adding an agent, and before each release."; exit 1; }
  command -v gh >/dev/null 2>&1 || { echo "This needs the GitHub CLI (gh), signed in: it sets the repository's PRIVACY_FINGERPRINTS secret."; exit 1; }
  mkdir -p "$UNITS"
  cat > "$UNITS/$NAME.service" <<UNIT
[Unit]
Description=Hatchabot: send GitHub the privacy check's keyed fingerprints

[Service]
Type=oneshot
# The user manager's PATH does not include a node installed by nvm or Homebrew, nor always gh.
Environment=PATH=$(dirname "$(command -v node)"):$(dirname "$(command -v gh)"):/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env node "$DIR/scripts/privacy-check.mjs" --sync-ci
$(for r in ${ALSO[@]+"${ALSO[@]}"}; do echo "ExecStart=/usr/bin/env node \"$DIR/scripts/privacy-check.mjs\" --sync-ci --repo $r"; done)
UNIT
  cat > "$UNITS/$NAME.timer" <<UNIT
[Unit]
Description=Hatchabot: sync the privacy fingerprints daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now "$NAME.timer"
  echo "GitHub's privacy fingerprints now sync daily from $DIR${ALSO[*]:+, also to ${ALSO[*]}}. Logs: journalctl --user -u $NAME"
  echo "Stop with: $0 --uninstall"
  exit 0
fi
if [ "${1:-}" = --uninstall ]; then
  systemctl --user disable --now "$NAME.timer" 2>/dev/null || true
  rm -f "$UNITS/$NAME.service" "$UNITS/$NAME.timer"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Stopped the daily sync. Sync by hand with: node scripts/privacy-check.mjs --sync-ci"
  exit 0
fi

exec node "$DIR/scripts/privacy-check.mjs" --sync-ci "$@"
