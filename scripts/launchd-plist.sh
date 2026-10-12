#!/usr/bin/env bash
# The launchd job a macOS host runs, written to stdout (setup-host.sh):
#
#   scripts/launchd-plist.sh service <install dir> <PATH for the job>
#   scripts/launchd-plist.sh backup  <install dir> <PATH for the job>
#
# Every path is XML-escaped where it sits in the file, and the install dir
# reaches bash as an argument ("$1"), never inside its command. Both were
# pasted in raw: a checkout under "Audit & Demo" made a file launchd could
# not read, and a quote or $ in the path would have broken the command (#227).
set -euo pipefail
KIND="${1:?usage: launchd-plist.sh service|backup <install dir> <PATH>}"
REPO="${2:?install dir}"
JOB_PATH="${3:?PATH for the job}"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"; }

# .env is read as a shell reads it (set -a exports each line), then the job.
case "$KIND" in
  service) LABEL=com.hatchabot.control-plane; RUN='./node_modules/.bin/tsx src/index.ts'; LOG=server.log
    WHEN='  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>' ;;
  backup) LABEL=com.hatchabot.backup; RUN='./scripts/backup-volumes.sh'; LOG=backup.log
    WHEN='  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer>
  </dict>' ;;
  *) echo "launchd-plist.sh: unknown job $KIND (service or backup)" >&2; exit 2 ;;
esac
CMD="cd \"\$1\" && set -a && . ./.env && set +a && exec $RUN"

cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-c</string>
    <string>$(xml "$CMD")</string>
    <string>hatchabot</string><string>$(xml "$REPO")</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(xml "$JOB_PATH")</string>
  </dict>
$WHEN
  <key>StandardOutPath</key><string>$(xml "$REPO/data/$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$REPO/data/$LOG")</string>
</dict></plist>
PLIST
