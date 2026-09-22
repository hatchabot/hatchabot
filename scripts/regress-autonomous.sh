#!/usr/bin/env bash
# Regression: build an autonomous agent entirely from the command line, and
# prove it works — it answers, remembers, runs a task on demand AND on its own
# schedule, stops when paused, and keeps its tasks and memory across a restart.
#
#   scripts/regress-autonomous.sh [--profile <AI source>] [--keep]
#
# Runs against the live control plane the CLI is signed in to, with REAL model
# turns (about eight). It makes one web-only agent named regress-<time> and
# deletes it at the end, pass or fail (--keep leaves it for a look).
# Exit status: 0 only if every step passed.
set -uo pipefail
HB="${HATCHABOT_CLI:-hatchabot}"
PROFILE=""; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done

NAME="regress-$(date +%m%d-%H%M%S)"
NONCE="$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
PASS=0; FAILED=0; RESULTS=()
t0=$(date +%s)
step() { STEP="$1"; STEP_T=$(date +%s); printf '▸ %s … ' "$1"; }
ok()   { PASS=$((PASS + 1)); RESULTS+=("✓ $STEP"); echo "ok ($(( $(date +%s) - STEP_T ))s)"; }
bad()  { FAILED=$((FAILED + 1)); RESULTS+=("✗ $STEP — $1"); echo "FAILED — $1"; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s);console.log(String(($1)(v)??''))}catch(e){console.log('')}})"; }

DONE=0
cleanup() {
  [ "$DONE" = 1 ] && return
  if [ "$KEEP" = 1 ]; then echo "kept: $NAME"; return; fi
  $HB delete "$NAME" --yes >/dev/null 2>&1 && echo "cleaned up: $NAME deleted" || true
}
trap cleanup EXIT

echo "Autonomous-agent regression — agent $NAME, nonce $NONCE"
echo

step "create a web-only agent from the CLI"
out=$($HB create "$NAME" --no-telegram --timeout 10 ${PROFILE:+--profile "$PROFILE"} \
  --persona "You are a regression-test agent. Follow instructions exactly. Answer with only what is asked, no extra words." 2>&1)
echo "$out" | grep -q "is RUNNING" && ok || { bad "$(echo "$out" | tail -1)"; echo; echo "Nothing else can run without the agent."; exit 1; }

step "it is listed as RUNNING (--json)"
st=$($HB list --json | json "v=>(v.find(a=>a.name==='$NAME')||{}).state")
[ "$st" = RUNNING ] && ok || bad "state is '${st:-missing}'"

step "ask: it answers"
r=$($HB ask "$NAME" "Reply with exactly this token and nothing else: PING-$NONCE" 2>&1)
echo "$r" | grep -q "PING-$NONCE" && ok || bad "reply: $(echo "$r" | head -c 200)"

step "ask: it remembers within the conversation"
$HB ask "$NAME" "Remember this codeword for later: BANANA-$NONCE. Reply only OK." >/dev/null 2>&1
r=$($HB ask "$NAME" "What codeword did I ask you to remember? Reply with only the codeword." 2>&1)
echo "$r" | grep -q "BANANA-$NONCE" && ok || bad "reply: $(echo "$r" | head -c 200)"

step "tasks add: a task every minute"
out=$($HB tasks "$NAME" add heartbeat --every 1m --quiet --message "Reply with exactly: BEAT-$NONCE" 2>&1)
echo "$out" | grep -q 'task "heartbeat" added' && ok || bad "$(echo "$out" | tail -1)"

step "tasks: listed, on"
line=$($HB tasks "$NAME" 2>&1 | grep heartbeat)
echo "$line" | grep -q "every 1m" && echo "$line" | grep -q " on " && ok || bad "listing: $line"

step "tasks run --wait: runs now and produces its answer"
run=$($HB tasks "$NAME" run heartbeat --wait --json --timeout 5 2>&1)
st=$(echo "$run" | json "v=>v.status"); sum=$(echo "$run" | json "v=>v.summary")
FIRST_AT=$(echo "$run" | json "v=>v.runAtMs")
[ "$st" = ok ] && echo "$sum" | grep -q "BEAT-$NONCE" && ok || bad "status '$st', summary: $(echo "$sum$run" | head -c 200)"

step "autonomy: the scheduler runs it on its own (wait up to 4 min)"
AUTO=""
for _ in $(seq 1 48); do
  AUTO=$($HB tasks "$NAME" runs heartbeat --json --limit 5 2>/dev/null | json "v=>{const r=v.find(r=>r.runAtMs>${FIRST_AT:-0}+20000);return r?JSON.stringify(r):''}")
  [ -n "$AUTO" ] && break
  sleep 5
done
if [ -n "$AUTO" ]; then
  st=$(echo "$AUTO" | json "v=>v.status"); sum=$(echo "$AUTO" | json "v=>v.summary")
  [ "$st" = ok ] && echo "$sum" | grep -q "BEAT-$NONCE" && ok || bad "scheduled run: status '$st', summary: $(echo "$sum" | head -c 200)"
else
  bad "no scheduled run within 4 min of the manual one"
fi

step "pause: it stops running on its own (watch 2.5 min)"
$HB tasks "$NAME" pause heartbeat >/dev/null 2>&1
sleep 5
N0=$($HB tasks "$NAME" runs heartbeat --json --limit 50 | json "v=>v.length")
sleep 150
N1=$($HB tasks "$NAME" runs heartbeat --json --limit 50 | json "v=>v.length")
line=$($HB tasks "$NAME" | grep heartbeat)
[ "$N0" = "$N1" ] && echo "$line" | grep -q " off " && ok || bad "runs went $N0 → $N1; listing: $line"

step "stop --wait / start --wait"
$HB stop "$NAME" --wait >/dev/null 2>&1 && $HB start "$NAME" --wait --timeout 10 >/dev/null 2>&1 \
  && ok || bad "$($HB list | grep "$NAME")"

step "after the restart: its task is still there, still paused"
line=$($HB tasks "$NAME" 2>&1 | grep heartbeat)
echo "$line" | grep -q " off " && ok || bad "listing: ${line:-no task}"

step "after the restart: it still remembers the codeword"
r=""
for _ in 1 2 3; do  # the gateway can take a few seconds to take turns after RUNNING
  r=$($HB ask "$NAME" "What codeword did I ask you to remember earlier? Reply with only the codeword." 2>&1) && break
  sleep 10
done
echo "$r" | grep -q "BANANA-$NONCE" && ok || bad "reply: $(echo "$r" | head -c 200)"

step "tasks rm"
$HB tasks "$NAME" rm heartbeat --yes >/dev/null 2>&1
$HB tasks "$NAME" 2>&1 | grep -q "no scheduled tasks" && ok || bad "$($HB tasks "$NAME" 2>&1 | head -2)"

step "delete"
if [ "$KEEP" = 1 ]; then RESULTS+=("– delete skipped (--keep)"); echo "skipped (--keep)"; else
  $HB delete "$NAME" --yes >/dev/null 2>&1
  sleep 3
  st=$($HB list --json | json "v=>(v.find(a=>a.name==='$NAME')||{}).state")
  [ -z "$st" ] || [ "$st" = DELETED ] || [ "$st" = DELETING ] && ok || bad "still listed as $st"
  DONE=1  # already deleted; the exit trap has nothing left to do
fi

echo
echo "── $PASS passed, $FAILED failed, $(( $(date +%s) - t0 ))s ──"
printf '%s\n' "${RESULTS[@]}"
[ "$FAILED" = 0 ]
