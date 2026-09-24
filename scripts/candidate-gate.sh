#!/usr/bin/env bash
# Candidate gate: is this runtime image safe to try on a real agent?
#
#   scripts/candidate-gate.sh <image tag> [--profile <AI source>] [--keep]
#   e.g.  scripts/candidate-gate.sh hatchabot-runtime:2026.9.6
#
# Runs on the Hatchabot host, against the live control plane the CLI is
# signed in to. It makes one web-only agent named gate-<time>, pins it to the
# candidate (hatchabot image try), and checks every place Hatchabot reads or
# writes OpenClaw's own formats (docs/embedder-and-openclaw-port-design.md,
# "The rest of the 2026.9 port"): the config it wrote is accepted, memory
# search indexes and answers, the CLI JSON shapes it parses, the files it reads,
# the console address. One real model turn. The agent is deleted at the end,
# pass or fail (--keep leaves it for a look).
#
# Exit status: 0 only if every step passed. Then: try it on one agent.
set -uo pipefail
HB="${HATCHABOT_CLI:-hatchabot}"
TAG=""; PROFILE=""; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -*) echo "unknown option $1"; exit 2 ;;
    *) TAG="$1"; shift ;;
  esac
done
[ -n "$TAG" ] || { echo "usage: scripts/candidate-gate.sh <image tag> [--profile <AI source>] [--keep]"; exit 2; }

NAME="gate-$(date +%m%d-%H%M%S)"
NONCE="$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
PASS=0; FAILED=0; RESULTS=()
step() { STEP="$1"; STEP_T=$(date +%s); printf '▸ %s … ' "$1"; }
ok()   { PASS=$((PASS + 1)); RESULTS+=("✓ $STEP"); echo "ok ($(( $(date +%s) - STEP_T ))s)"; }
bad()  { FAILED=$((FAILED + 1)); RESULTS+=("✗ $STEP — $1"); echo "FAILED — $1"; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s);console.log(String(($1)(v)??''))}catch(e){console.log('')}})"; }
# `docker exec` in the agent's container, as the agent (uid 1000, HOME on the volume).
inagent() { docker exec "$CONTAINER" bash -lc "$1" 2>&1; }

DONE=0
cleanup() {
  [ "$DONE" = 1 ] && return
  if [ "$KEEP" = 1 ]; then echo "kept: $NAME"; return; fi
  $HB delete "$NAME" --yes >/dev/null 2>&1 && echo "cleaned up: $NAME deleted" || true
}
trap cleanup EXIT

echo "Candidate gate — image $TAG, agent $NAME, nonce $NONCE"
echo

step "the image is on this machine and says which OpenClaw it runs"
VERSION="$(docker image inspect "$TAG" --format '{{ index .Config.Labels "org.agentclaw.openclaw-version" }}' 2>/dev/null)"
ENGINE="$(docker image inspect "$TAG" --format '{{ index .Config.Labels "org.hatchabot.embed-engine" }}' 2>/dev/null)"
[ -n "$VERSION" ] && ok || { bad "no such image, or no openclaw-version label"; exit 1; }
[ "$ENGINE" = none ] || ENGINE=baked
# Memory search keys moved under memory.search in 2026.8 (configWriter.ts memoryKeyPrefix).
if [ "$(printf '%s\n%s\n' "2026.8.0" "$VERSION" | sed 's/-/~/' | sort -V | head -1)" = "2026.8.0" ]; then MEMKEY="memory.search"; else MEMKEY="agents.defaults.memorySearch"; fi
echo "  OpenClaw $VERSION · engine $ENGINE · memory keys under $MEMKEY"

if [ "$ENGINE" = none ]; then
  step "the shared memory search service is on (the image has no engine of its own)"
  $HB embedder 2>&1 | grep -q 'engine running' && ok || { bad "start it first: $HB embedder start"; exit 1; }
fi

step "create a web-only agent from the CLI"
out=$($HB create "$NAME" --no-telegram --timeout 10 ${PROFILE:+--profile "$PROFILE"} \
  --persona "You are a gate-test agent. Follow instructions exactly. Answer with only what is asked, no extra words." 2>&1)
echo "$out" | grep -q "is RUNNING" && ok || { bad "$(echo "$out" | tail -1)"; echo; echo "Nothing else can run without the agent."; exit 1; }
SLUG=$($HB list --json | json "v=>(v.find(a=>a.name==='$NAME')||{}).slug")
[ -n "$SLUG" ] || SLUG="$(printf '%s' "$NAME" | tr 'A-Z' 'a-z')"

step "pin it to the candidate and rebuild (hatchabot image try)"
out=$($HB image try "$NAME" "$TAG" 2>&1)
if echo "$out" | grep -q "rebuilding"; then
  st=""
  for i in $(seq 1 120); do
    st=$($HB list --json | json "v=>(v.find(a=>a.name==='$NAME')||{}).state")
    case "$st" in RUNNING|FAILED) break ;; esac
    sleep 5
  done
  [ "$st" = RUNNING ] && ok || bad "state is '${st:-missing}' after the rebuild"
else
  bad "$(echo "$out" | tail -1)"
fi
CONTAINER="$(docker ps --format '{{.Names}}' | grep -E "^(hatchabot|agentclaw)-${SLUG}-" | head -1)"
[ -n "$CONTAINER" ] || { echo "no running container for $SLUG"; exit 1; }

step "the container runs the candidate image, and openclaw --version agrees"
img="$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')"
runs="$(inagent 'openclaw --version 2>/dev/null | head -1')"
[ "$img" = "$TAG" ] && echo "$runs" | grep -q "$VERSION" && ok || bad "image $img, runs '$runs'"

step "openclaw doctor accepts the config Hatchabot wrote (no errors; no post-upgrade findings)"
errs="$(inagent "openclaw doctor --lint --json --severity-min error 2>/dev/null" | json 'v=>(v.findings||[]).map(f=>f.checkId+": "+f.message).join(" | ")')"
post="$(inagent "openclaw doctor --post-upgrade --json 2>/dev/null" | json 'v=>(v.findings||[]).map(f=>JSON.stringify(f)).join(" | ")')"
[ -z "$errs" ] && [ -z "$post" ] && ok || bad "${errs:-}${errs:+ · }${post:-}"

step "memory search provider is under $MEMKEY and matches the engine"
prov="$(inagent "openclaw config get $MEMKEY.provider 2>/dev/null" | tr -d '\"[:space:]')"
if [ "$ENGINE" = none ]; then want="openai-compatible"; else want="local|openai-compatible"; fi
echo "$prov" | grep -qE "^($want)$" && ok || bad "$MEMKEY.provider is '$prov' (wanted $want)"

step "memory index and a semantic search that shares no keyword with the memory"
WS="/home/node/.openclaw/agents/$SLUG/agent"
inagent "printf '\n- The household tortoise is called Bartholomew-$NONCE and eats dandelions.\n' >> $WS/MEMORY.md" >/dev/null
idx="$(inagent "openclaw memory index --force --agent $SLUG 2>&1 | tail -3")"
stat="$(inagent "openclaw memory status --deep --agent $SLUG 2>&1")"
hit="$(inagent "openclaw memory search --agent $SLUG --json --query 'what reptile pet lives here and what does it eat' 2>/dev/null" | json 'v=>JSON.stringify(v)')"
if echo "$stat" | grep -qi 'Embeddings: *ready' && echo "$stat" | grep -qi 'Semantic vectors: *ready' && echo "$hit" | grep -q "Bartholomew-$NONCE"; then ok
else bad "index: $(echo "$idx" | tr '\n' ' ' | head -c 160) · status: $(echo "$stat" | grep -iE 'embeddings|vectors' | tr '\n' ' ') · hit: $(echo "$hit" | head -c 120)"; fi

step "ask: it answers (one real model turn on the candidate)"
r=$($HB ask "$NAME" "Reply with exactly this token and nothing else: PING-$NONCE" 2>&1)
echo "$r" | grep -q "PING-$NONCE" && ok || bad "reply: $(echo "$r" | head -c 200)"

step "sessions list --json has the shape the app reads (sessions[].updatedAt, key agent:$SLUG:main)"
s="$(inagent "openclaw sessions list --agent $SLUG --json 2>/dev/null" | json "v=>(v.sessions||[]).filter(s=>typeof s.updatedAt==='number'&&s.key==='agent:$SLUG:main').length")"
[ "${s:-0}" -ge 1 ] 2>/dev/null && ok || bad "no session with a numeric updatedAt and the main key"

step "sessions.json is where the app reads it"
inagent "test -s /home/node/.openclaw/agents/$SLUG/sessions/sessions.json && node -e 'JSON.parse(require(\"fs\").readFileSync(\"/home/node/.openclaw/agents/$SLUG/sessions/sessions.json\",\"utf8\"))'" >/dev/null && ok || bad "missing or not JSON"

step "cron list --all --json has the shape the app reads (jobs[])"
c="$(inagent "openclaw cron list --agent $SLUG --all --json 2>/dev/null" | json 'v=>Array.isArray(v.jobs)?"array":"no"')"
[ "$c" = array ] && ok || bad "no jobs array"

step "models list --json has the shape the app reads (key strings, provider-qualified)"
m="$(inagent "openclaw models list --provider anthropic --all --json 2>/dev/null" | json 'v=>{const a=Array.isArray(v)?v:(v&&Array.isArray(v.models)?v.models:[]);return a.filter(x=>x&&typeof x.key==="string"&&x.key.startsWith("anthropic/")).length}')"
[ "${m:-0}" -ge 1 ] 2>/dev/null && ok || bad "no anthropic/* entries"

step "devices list --json has pending[] and paired[]; devices/pending.json absent or JSON"
d="$(inagent "openclaw devices list --json 2>/dev/null" | json 'v=>Array.isArray(v.pending)&&Array.isArray(v.paired)?"ok":"no"')"
pf="$(inagent 'f=$HOME/.openclaw/devices/pending.json; if [ -f "$f" ]; then node -e "JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"))" "$f" && echo ok; else echo absent; fi')"
[ "$d" = ok ] && echo "$pf" | grep -qE 'ok|absent' && ok || bad "devices: $d · pending.json: $pf"

step "the console answers at ?session=agent:$SLUG:main"
code="$(inagent "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:18789/?session=agent:$SLUG:main'")"
[ "$code" = 200 ] && ok || bad "HTTP $code"

step "the plugins the image says it carries are there, and web search is enabled"
chans="$(docker image inspect "$TAG" --format '{{ index .Config.Labels "org.hatchabot.channels" }}')"
baked="$(docker image inspect "$TAG" --format '{{ index .Config.Labels "org.hatchabot.plugins" }}')"
miss=""
for p in $(printf '%s' "$chans" | tr ',' ' '); do
  inagent "test -f /opt/hatchabot/plugins/$p/node_modules/@openclaw/$p/dist/index.js" >/dev/null || miss="$miss $p"
done
for pair in $(printf '%s' "$baked" | tr ',' ' '); do
  id="${pair%%=*}"; pkg="${pair#*=}"
  inagent "test -f /opt/hatchabot/plugins/$id/node_modules/$pkg/dist/index.js" >/dev/null || miss="$miss $id"
done
ddg="$(inagent 'openclaw plugins list --json 2>/dev/null' | json 'v=>{const a=Array.isArray(v)?v:(v.plugins||[]);const p=a.find(x=>x.id==="duckduckgo");return p?String(p.enabled):"absent"}')"
[ -z "$miss" ] && [ "$ddg" = true ] && ok || bad "missing in the image:${miss:- none} · duckduckgo plugin: $ddg"

DONE=1
echo
echo "Results ($PASS passed, $FAILED failed) for $TAG:"
printf '  %s\n' "${RESULTS[@]}"
if [ "$KEEP" = 1 ]; then echo "kept: $NAME (pinned to $TAG)"; else $HB delete "$NAME" --yes >/dev/null 2>&1 && echo "cleaned up: $NAME deleted"; fi
if [ "$FAILED" = 0 ]; then
  echo "✅ $TAG passes the gate. Next: try it on one real agent — hatchabot image try \"<agent>\" $TAG"
else
  echo "✗ $TAG is not ready. Not covered here (check by hand): the management agent's tool lockdown (it stays pinned and moves last)."
  exit 1
fi
