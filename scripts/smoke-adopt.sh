#!/usr/bin/env bash
#
# Live end-to-end smoke test for the adopt flow — the one thing the unit suite
# can't prove, because it fakes Docker and Telegram. This adopts a THROWAWAY
# workspace against the real running Hatchabot, real Docker, and a real Telegram
# bot, asserts the container actually comes up, then deletes everything.
#
# It is NOT part of `vitest` (that stays hermetic). Run it by hand, or in a
# nightly job, on a machine with the stack installed:
#
#   HATCHABOT_SMOKE_BOT_TOKEN=<a throwaway BotFather token> ./scripts/smoke-adopt.sh
#
# The bot is only wired to the disposable agent and is freed (unwired) when the
# agent is deleted at the end; it still exists at BotFather for the next run.
set -uo pipefail

# Load a git-ignored .env.smoke (0600) if present, so the token lives in one
# file instead of your shell history. A real env var still wins.
if [ -f .env.smoke ]; then set -a; . ./.env.smoke; set +a; fi

NAME="aclaw-smoke-$(date +%s)"
WS="$(mktemp -d)"
FAILED=0

step() { printf '\n\033[1m• %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*"; FAILED=1; exit 1; }

cleanup() {
  step "Cleanup"
  hatchabot delete "$NAME" --yes >/dev/null 2>&1 && ok "deleted agent $NAME (container + volume purged)" \
    || printf '  (nothing to delete — %s never got created)\n' "$NAME"
  rm -rf "$WS"
  if [ "$FAILED" -eq 0 ]; then printf '\n\033[1;32mSMOKE PASS\033[0m\n'; else printf '\n\033[1;31mSMOKE FAIL\033[0m\n'; fi
}
trap cleanup EXIT

# ---- preflight --------------------------------------------------------------
step "Preflight"
command -v hatchabot >/dev/null || die "hatchabot CLI not on PATH"
command -v docker    >/dev/null || die "docker not on PATH"
docker info >/dev/null 2>&1     || die "docker daemon not reachable"
hatchabot list >/dev/null 2>&1  || die "Hatchabot not reachable / not logged in (run: hatchabot login)"
ok "CLI, docker, and a logged-in server are all present"

if [ -z "${HATCHABOT_SMOKE_BOT_TOKEN:-}" ]; then
  printf '\n\033[33mSKIP\033[0m: set HATCHABOT_SMOKE_BOT_TOKEN to a throwaway BotFather token to run the live test.\n'
  trap - EXIT; rm -rf "$WS"; exit 0
fi

# ---- a disposable OpenClaw-style workspace ----------------------------------
step "Build a throwaway workspace at $WS"
cat > "$WS/SOUL.md" <<'MD'
# Smoke Test Agent
A disposable agent that exists only to verify Hatchabot's adopt flow end to end.
It will be deleted moments after it boots.
MD
printf 'Answer in one short sentence.\n' > "$WS/AGENTS.md"
printf '(smoke run — no real memory)\n'  > "$WS/MEMORY.md"
ok "wrote SOUL.md / AGENTS.md / MEMORY.md"

# ---- adopt (real create → real bot → real container → real workspace copy) --
step "Adopt it as \"$NAME\""
if ! hatchabot adopt "$WS" "$NAME" --bot-token "$HATCHABOT_SMOKE_BOT_TOKEN"; then
  die "adopt command failed"
fi
ok "adopt command returned success"

# ---- assert it is actually RUNNING ------------------------------------------
step "Verify it came up"
running=0
for _ in $(seq 1 45); do
  # `list` prints "<name> <STATE> <model> …"; our name is space-free by
  # construction, so it is exactly field 1 and the state is field 2. (Other
  # agents' multi-word names never equal $1, so there's no false match.)
  state="$(hatchabot list | awk -v n="$NAME" '$1==n {print $2; exit}')"
  if [ "$state" = "RUNNING" ]; then running=1; break; fi
  if [ "$state" = "FAILED" ]; then die "agent went to FAILED"; fi
  sleep 2
done
[ "$running" -eq 1 ] || die "agent did not reach RUNNING within ~90s (last state: ${state:-unknown})"
ok "agent state is RUNNING"

# A real container backs it (the thing the fakes can't prove).
if docker ps --format '{{.Names}}' | grep -q "^hatchabot-${NAME}-"; then
  ok "a Docker container is up: $(docker ps --format '{{.Names}}' | grep "^hatchabot-${NAME}-")"
else
  die "no running Docker container matches hatchabot-${NAME}-*"
fi

# The bot token Telegram actually accepts (soft — network hiccups shouldn't fail).
if hatchabot health "$NAME" >/dev/null 2>&1; then
  ok "health check answered"
else
  printf '  (health check did not answer — not failing the smoke on a transient)\n'
fi

# cleanup + PASS/FAIL banner run from the EXIT trap.
