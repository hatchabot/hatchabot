#!/usr/bin/env bash
# Claude Code keeps its config at ~/.claude.json — OUTSIDE the mounted
# ~/.claude directory — and refuses to run without it. Seed the minimum on
# first boot; the CLI grows the file from there (ephemeral per container,
# which is fine: nothing durable lives in it).
set -e
if [ ! -f "$HOME/.claude.json" ]; then
  echo '{"hasCompletedOnboarding": true}' > "$HOME/.claude.json"
fi

# Per-agent Python libraries live on the volume, not in the shared image: an
# agent runs `pip install --target /home/node/.openclaw/pylibs <pkg>` and its
# scripts import them because we prepend that dir to PYTHONPATH here. Absent for
# agents that need no libraries — the base image stays lean either way.
PYLIBS="$HOME/.openclaw/pylibs"
if [ -d "$PYLIBS" ]; then
  export PYTHONPATH="$PYLIBS${PYTHONPATH:+:$PYTHONPATH}"
fi

exec "$@"
