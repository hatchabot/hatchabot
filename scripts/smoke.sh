#!/usr/bin/env bash
#
# One command to run the live smoke test. Runs the full, ISOLATED adopt smoke
# (`smoke-adopt-full.ts`): a throwaway control plane on its own port + Docker
# namespace adopts an OpenClaw agent end to end against real Docker — the path
# someone switching to Hatchabot takes — then tears everything down. Never
# touches your real server or agents.
#
#   ./scripts/smoke.sh          (or: npm run smoke)
#
# It adopts web-only (no Telegram) and checks the console answers. To take
# over a real bot instead, run it with --with-telegram and a throwaway
# BotFather token in a git-ignored .env.smoke (chmod 600) at the repo root —
# the script auto-loads it:
#
#   HATCHABOT_SMOKE_BOT_TOKEN=<token>
#   # optional: HATCHABOT_SMOKE_AI_KEY=<real anthropic key>, HATCHABOT_SMOKE_PORT=18099
set -uo pipefail
cd "$(dirname "$0")/.."

if [ ! -x node_modules/.bin/tsx ]; then
  echo "✗ tsx not found — run 'npm install' first." >&2
  exit 1
fi

exec node_modules/.bin/tsx scripts/smoke-adopt-full.ts "$@"
