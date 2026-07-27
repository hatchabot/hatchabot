#!/usr/bin/env bash
# Claude Code keeps its config at ~/.claude.json — OUTSIDE the mounted
# ~/.claude directory — and refuses to run without it. Seed the minimum on
# first boot; the CLI grows the file from there (ephemeral per container,
# which is fine: nothing durable lives in it).
set -e
if [ ! -f "$HOME/.claude.json" ]; then
  echo '{"hasCompletedOnboarding": true}' > "$HOME/.claude.json"
fi
exec "$@"
