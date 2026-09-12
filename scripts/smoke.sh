#!/usr/bin/env bash
#
# One command to run the live smoke test. Runs the full, ISOLATED adopt smoke
# (`smoke-adopt-full.ts`): a throwaway control plane on its own port + Docker
# namespace adopts an agent end to end against real Docker + a real Telegram
# bot, then tears everything down. Never touches your real server or agents.
#
#   ./scripts/smoke.sh          (or: npm run smoke)
#
# Needs a throwaway BotFather token. Put it in a git-ignored .env.smoke
# (chmod 600) at the repo root — the script auto-loads it:
#
#   HATCHABOT_SMOKE_BOT_TOKEN=<token>
#   # optional: HATCHABOT_SMOKE_AI_KEY=<real anthropic key>, HATCHABOT_SMOKE_PORT=18099
#
# Without a token it SKIPs cleanly (exit 0), so it's safe to wire into CI/cron.
set -uo pipefail
cd "$(dirname "$0")/.."

if [ ! -x node_modules/.bin/tsx ]; then
  echo "✗ tsx not found — run 'npm install' first." >&2
  exit 1
fi

exec node_modules/.bin/tsx scripts/smoke-adopt-full.ts
