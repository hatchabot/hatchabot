#!/usr/bin/env bash
# Two tenants on one machine, each a Linux user with its own rootless Docker
# and its own Hatchabot — the shared host of Hatchabot Cloud (its
# docs/architecture.md §5) — and the proof that neither can reach the other.
# The cloud's provisioner does what this script does, by hand here so a
# release can be tried before any customer lands on it.
#
#   scripts/shared-host-test.sh                         # latest release, two tenants
#   scripts/shared-host-test.sh --channel stable --keep
#   scripts/shared-host-test.sh --ai-source "Claude Max Setup Token"
#                                                       # …and each tenant talks to an agent and to its manager
#
# In a fresh Ubuntu 24.04 VM (LXD, on this machine):
#   1. host prep, as root, once: Docker Engine, the rootless packages, Node 22,
#      build tools, cgroup delegation for user services, a `caddy` user standing
#      in for the router;
#   2. per tenant: a user with linger, rootless Docker with host loopback on
#      (agents reach the tenant's Hatchabot at 10.0.2.2), the public installer
#      run unattended with that tenant's ports in .env, a memory ceiling on the
#      user's slice, and a socket-owner firewall rule on its ports;
#   3. per tenant: the owner account and a CLI token, doctor, and with
#      --ai-source an agent and the Hatchabot agent, each asked a question —
#      the manager's answer proves its door works under rootless networking;
#   4. isolation: a tenant's shell and a tenant's container try the other
#      tenant's ports; the router user and root reach both;
#   5. deletes the VM (unless --keep). Logs stay in ~/hatchabot-shared-host/<time>/.
#
# Needs LXD (see clean-install-test.sh). On a machine that also runs Docker the
# VM has no internet until Docker's firewall lets LXD's bridge through; the
# script checks and says how.
set -uo pipefail
CHANNEL=latest; KEEP=0; AI_SOURCE=""; TENANTS=2; VM=""
INSTALLER_URL="https://raw.githubusercontent.com/hatchabot/hatchabot/main/install.sh"
while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --ai-source) AI_SOURCE="$2"; shift 2 ;;
    --tenants) TENANTS="$2"; shift 2 ;;
    --vm) VM="$2"; shift 2 ;;                 # reuse a VM this script kept (host prep is skipped if done)
    --installer-url) INSTALLER_URL="$2"; shift 2 ;;
    -h|--help) sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1 (see --help)"; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FRESH=0; [ -n "$VM" ] || { VM="hb-shared-$(date +%m%d%H%M%S)"; FRESH=1; }
OUT="$HOME/hatchabot-shared-host/$(date +%Y-%m-%d-%H%M%S)"
mkdir -p "$OUT"; chmod 700 "$OUT"
PASS=0; FAIL=0; RESULTS=()
ok()  { PASS=$((PASS + 1)); RESULTS+=("✓ $1"); echo "✓ $1"; }
bad() { FAIL=$((FAIL + 1)); RESULTS+=("✗ $1"); echo "✗ $1"; }

L() { if id -nG | grep -qw lxd; then lxc "$@"; else sg lxd -c "lxc $(printf '%q ' "$@")"; fi; }
# A script on the VM's stdin, as root.
root() { L exec "$VM" -- bash -s; }
# …as a tenant, with the user manager's environment (linger gives it a runtime dir).
tenant() { local u="$1"; shift; L exec "$VM" -- su - "$u" -c "export XDG_RUNTIME_DIR=/run/user/\$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/\$(id -u)/bus; $*"; }
tenanti() { local u="$1"; shift; tenant "$u" "bash -ic $(printf '%q' "$*") 2>&1" | grep -vE '^bash: (cannot set terminal|no job control)'; }

command -v lxc >/dev/null || { echo "LXD is not installed. sudo snap install lxd && sudo lxd init --auto && sudo usermod -aG lxd \$USER"; exit 2; }
cleanup() {
  if [ "$KEEP" = 1 ]; then echo "kept: $VM   (lxc exec $VM -- su - t1 · lxc delete $VM --force)"; return; fi
  L delete "$VM" --force >/dev/null 2>&1 && echo "deleted $VM"
}
trap cleanup EXIT

echo "Shared host test — $VM, channel $CHANNEL, $TENANTS tenants, logs in $OUT"
echo
if [ "$FRESH" = 1 ]; then
  timeout 600 bash -c "$(declare -f L); L launch ubuntu:24.04 $VM --vm -c limits.cpu=6 -c limits.memory=16GiB -d root,size=80GiB" </dev/null >"$OUT/launch.log" 2>&1 \
    || { bad "launch a fresh Ubuntu 24.04 VM ($(tail -1 "$OUT/launch.log"))"; exit 1; }
  for _ in $(seq 1 60); do L exec "$VM" -- cloud-init status 2>/dev/null | grep -q done && break; sleep 5; done
  ok "fresh Ubuntu 24.04 VM ($(L exec "$VM" -- uname -m))"
fi
if ! L exec "$VM" -- sh -c 'timeout 8 ping -c1 -W5 1.1.1.1 >/dev/null 2>&1'; then
  bad "the VM has no internet"
  echo "  Once per boot:  sudo iptables -I DOCKER-USER -i lxdbr0 -j ACCEPT"
  echo "                  sudo iptables -I DOCKER-USER -o lxdbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT"
  exit 1
fi

# ---- 1. host prep (what the provisioner does to a new host, once) ----------------
root >"$OUT/hostprep.log" 2>&1 <<'EOF'
set -e; export DEBIAN_FRONTEND=noninteractive
# Agents on one daemon are kept apart on the network (enable_icc=false), which needs br_netfilter — root's job, a rootless daemon cannot load it.
modprobe br_netfilter && echo br_netfilter > /etc/modules-load.d/br_netfilter.conf
[ -f /var/lib/hb-shared-prepped ] && { echo "already prepped"; exit 0; }
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
apt-get -qq update
apt-get -qq install -y uidmap slirp4netns dbus-user-session nftables git build-essential python3 curl expect
command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] \
  || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null; apt-get -qq install -y nodejs; }
# Rootless Docker's --memory/--pids-limit need the user slice to own its cgroup controllers.
mkdir -p /etc/systemd/system/user@.service.d
printf '[Service]\nDelegate=cpu cpuset io memory pids\n' > /etc/systemd/system/user@.service.d/delegate.conf
systemctl daemon-reload
id caddy >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin caddy
nft list table inet hb >/dev/null 2>&1 || { nft add table inet hb; nft add chain inet hb out '{ type filter hook output priority 0; }'; }
touch /var/lib/hb-shared-prepped
echo "prepped: docker $(docker --version | awk '{print $3}') node $(node --version)"
EOF
grep -q "prepped" "$OUT/hostprep.log" && ok "host prepared: $(grep -o 'prepped.*' "$OUT/hostprep.log" | tail -1)" || { bad "host prep — $(tail -3 "$OUT/hostprep.log" | tr '\n' ' ')"; exit 1; }

# ---- 2. tenants -----------------------------------------------------------------
# Tenant i owns: PORT 810i, ops door 819i, memory-search door 809i, gateway ports 19i00–19i99.
declare -A PORT OPS EMBED GWBASE UIDOF TOKEN
for i in $(seq 1 "$TENANTS"); do
  u="t$i"; PORT[$u]=$((8100 + i)); OPS[$u]=$((8190 + i)); EMBED[$u]=$((8090 + i)); GWBASE[$u]=$((19000 + i * 100))
  root >"$OUT/$u-user.log" 2>&1 <<EOF
set -e
id $u >/dev/null 2>&1 || useradd -m -s /bin/bash $u
loginctl enable-linger $u
# A memory ceiling on everything the tenant runs: reclaim starts at MemoryHigh, MemoryMax is the wall.
systemctl set-property user-\$(id -u $u).slice MemoryHigh=3G MemoryMax=4G TasksMax=2048 >/dev/null 2>&1 || true
sleep 1; echo "uid \$(id -u $u)"
EOF
  UIDOF[$u]=$(grep -o 'uid [0-9]*' "$OUT/$u-user.log" | awk '{print $2}')
  [ -n "${UIDOF[$u]}" ] || { bad "$u: user not created — $(tail -2 "$OUT/$u-user.log" | tr '\n' ' ')"; exit 1; }

  tenant "$u" 'bash -s' >"$OUT/$u-rootless.log" 2>&1 <<'EOF'
set -e
if [ ! -S "$XDG_RUNTIME_DIR/docker.sock" ]; then
  mkdir -p ~/.config/systemd/user/docker.service.d
  # Containers may reach this machine's loopback (10.0.2.2): that is how agents reach their Hatchabot.
  printf '[Service]\nEnvironment=DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false\n' > ~/.config/systemd/user/docker.service.d/loopback.conf
  dockerd-rootless-setuptool.sh install
fi
export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock
docker info --format 'rootless={{.SecurityOptions}}'
EOF
  grep -q 'name=rootless' "$OUT/$u-rootless.log" && ok "$u: rootless Docker up (uid ${UIDOF[$u]}, host loopback on)" || { bad "$u: rootless Docker — $(tail -3 "$OUT/$u-rootless.log" | tr '\n' ' ')"; exit 1; }

  # The public installer, unattended, with this tenant's .env.
  ENV_LINES="DOCKER_HOST=unix:///run/user/${UIDOF[$u]}/docker.sock
HATCHABOT_OPS_PORT=${OPS[$u]}
HATCHABOT_EMBED_PORT=${EMBED[$u]}
HATCHABOT_GATEWAY_PORT_BASE=${GWBASE[$u]}
HATCHABOT_PREFIX=$u
HATCHABOT_MAX_AGENTS_TOTAL=3
HATCHABOT_AGENT_MEMORY=2g
HATCHABOT_PUBLIC_URL=http://127.0.0.1:${PORT[$u]}"
  # A script in the tenant's home, not a quoted one-liner through lxc + su: three shells deep, $(…) lands in the wrong one.
  { printf '#!/usr/bin/env bash\nexport HATCHABOT_YES=1 HATCHABOT_CHANNEL=%q HATCHABOT_SETUP_SIGNIN=accounts HATCHABOT_SETUP_PORT=%q\nexport HATCHABOT_SETUP_ENV=%q\n' "$CHANNEL" "${PORT[$u]}" "$ENV_LINES"
    printf 'bash -c "$(curl -fsSL %q)"\n' "$INSTALLER_URL"; } >"$OUT/$u-install-run.sh"
  L file push "$OUT/$u-install-run.sh" "$VM/home/$u/install-run.sh" --uid "${UIDOF[$u]}" --gid "${UIDOF[$u]}" --mode 0700 >/dev/null
  tenant "$u" '~/install-run.sh' >"$OUT/$u-install.log" 2>&1
  # A kept VM keeps its .env: bring the memory cap to what this script wants (a 2026.9 gateway idles at ~700 MiB; 1 GiB thrashed).
  tenant "$u" "grep -q '^HATCHABOT_AGENT_MEMORY=2g' ~/hatchabot/.env || { sed -i 's/^HATCHABOT_AGENT_MEMORY=.*/HATCHABOT_AGENT_MEMORY=2g/' ~/hatchabot/.env; systemctl --user restart hatchabot; }" >/dev/null 2>&1
  # Older releases' setup did not record a non-8080 port for the CLI.
  tenant "$u" "mkdir -p ~/.config/hatchabot; grep -q '^HATCHABOT_URL=' ~/.config/hatchabot/env 2>/dev/null || echo HATCHABOT_URL=http://127.0.0.1:${PORT[$u]} >> ~/.config/hatchabot/env; chmod 600 ~/.config/hatchabot/env" >/dev/null 2>&1
  if tenant "$u" 'systemctl --user is-active hatchabot' 2>/dev/null | grep -q '^active'; then
    ok "$u: installed from $INSTALLER_URL on port ${PORT[$u]} ($(sed -n 's/.*channel [a-z0-9.]* → release \(v[0-9.]*\).*/\1/p' "$OUT/$u-install.log" | head -1))"
  else
    bad "$u: install — $(sed 's/\r//g' "$OUT/$u-install.log" | grep -E '✗|ERR!|rror' | tail -3 | tr '\n' ' ')"; exit 1
  fi

  # Its ports answer only its own user, the router, and root — never another tenant or another tenant's containers.
  root >"$OUT/$u-nft.log" 2>&1 <<EOF
nft add rule inet hb out oif lo tcp dport { ${PORT[$u]}, ${OPS[$u]}, ${EMBED[$u]}, ${GWBASE[$u]}-$((GWBASE[$u] + 99)) } meta skuid != { ${UIDOF[$u]}, \$(id -u caddy), 0 } reject with tcp reset
EOF
done

# ---- 3. what the provisioner does next: the owner, doctor, and (with --ai-source) agents --------
CRED=""
if [ -n "$AI_SOURCE" ]; then
  TOK=$(sed -n 's/^HATCHABOT_TOKEN=//p' "$HOME/.config/hatchabot/env" 2>/dev/null | tail -1)
  URL=$(sed -n 's/^HATCHABOT_URL=//p' "$HOME/.config/hatchabot/env" 2>/dev/null | tail -1); URL="${URL:-http://127.0.0.1:8080}"
  CRED="$OUT/.cred"; umask 077
  PID=$(curl -s -H "authorization: Bearer $TOK" "$URL/v1/ai-profiles" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);const p=r.find(p=>p.id==='$AI_SOURCE'||p.name==='$AI_SOURCE');if(p)console.log(p.id,p.kind,p.vendor,p.model)})")
  if [ -z "$PID" ]; then bad "no AI source \"$AI_SOURCE\" on this machine (hbt sources)"; CRED=""; else
    set -- $PID; KIND=$2; VENDOR=$3; MODEL=$4
    curl -s -H "authorization: Bearer $TOK" "$URL/v1/ai-profiles/$1/credential" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);if(v.credential)process.stdout.write(v.credential)})" >"$CRED"
    [ -s "$CRED" ] || { bad "could not read the credential of \"$AI_SOURCE\""; CRED=""; }
  fi
fi

for i in $(seq 1 "$TENANTS"); do
  u="t$i"; B="http://127.0.0.1:${PORT[$u]}"
  # A kept VM already has the owner: its saved CLI token serves again.
  TOKEN[$u]=$(tenant "$u" "sed -n 's/^HATCHABOT_TOKEN=//p' ~/.config/hatchabot/env 2>/dev/null" | tr -d '\r' | tail -1)
  if [ -n "${TOKEN[$u]}" ] && [ "$(tenant "$u" "curl -s -o /dev/null -w '%{http_code}' -H 'authorization: Bearer ${TOKEN[$u]}' $B/v1/agents" | tr -d '\r')" = 200 ]; then
    ok "$u: owner account already there (kept VM) — its CLI token still works"
  else
    ACC=$(tenanti "$u" "hbt accounts create owner --host-owner --cli-token --json" 2>/dev/null | grep '^{' | tail -1)
    TOKEN[$u]=$(printf %s "$ACC" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).cliToken||'')}catch{console.log('')}})")
    [ -n "${TOKEN[$u]}" ] && ok "$u: owner account + CLI token without a browser" || { bad "$u: hbt accounts create — ${ACC:-no output}"; continue; }
    tenanti "$u" "hatchabot login --token ${TOKEN[$u]} --url $B" >/dev/null 2>&1
  fi

  tenanti "$u" 'hatchabot doctor --json' >"$OUT/$u-doctor.json" 2>/dev/null
  DOC=$(node -e "const v=JSON.parse(require('fs').readFileSync('$OUT/$u-doctor.json','utf8'));const l=v.lines||v.report||[];const bad=l.filter(x=>x.level==='fail').map(x=>x.text);const d=l.find(x=>/^Docker /.test(x.text));console.log((bad.length?'FAIL '+bad.join(' · '):'OK')+'|'+(d&&/rootless/.test(d.text)?'rootless':'no-rootless-line'))" 2>/dev/null || echo "FAIL unreadable|?")
  case "$DOC" in OK\|rootless) ok "$u: doctor all good, and it says Docker is rootless" ;; OK\|*) bad "$u: doctor is fine but does not mention rootless Docker" ;; *) bad "$u: doctor — ${DOC%%|*}" ;; esac

  if [ -n "$CRED" ]; then
    L file push "$CRED" "$VM/home/$u/.cred" --uid "${UIDOF[$u]}" --gid "${UIDOF[$u]}" --mode 0600 >/dev/null
    cat >"$OUT/$u-agents.sh" <<EOF
#!/usr/bin/env bash
B=$B; H="authorization: Bearer ${TOKEN[$u]}"
node -e 'const fs=require("fs");const c=fs.readFileSync(process.env.HOME+"/.cred","utf8").trim();const sub="$KIND"==="subscription";process.stdout.write(JSON.stringify(Object.assign({kind:sub?"subscription":"api_key",vendor:"$VENDOR",name:"$AI_SOURCE",model:"$MODEL"},sub?{oauthToken:c}:{apiKey:c})))' >/tmp/body.json
curl -s -H "\$H" -H 'content-type: application/json' --data @/tmp/body.json \$B/v1/ai-profiles >/dev/null; rm -f /tmp/body.json ~/.cred
PID=\$(curl -s -H "\$H" \$B/v1/ai-profiles | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].id))")
# A kept VM may already have Helper (a failed one from an earlier run is retried).
HS=\$(hbt list --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s).find(x=>x.name==='Helper');console.log(a?a.state:'')})")
case "\$HS" in
  "") hbt create Helper --no-telegram --persona 'You answer in one word.' >/tmp/create.log 2>&1 || grep -q "retry requested" /tmp/create.log || { echo "FAIL create: \$(tail -1 /tmp/create.log)"; exit 0; } ;;
  FAILED) hbt retry Helper >/tmp/create.log 2>&1 || true ;;
esac
# The Hatchabot agent: made once; a failed one from an earlier run is retried.
OS=\$(curl -s -H "\$H" \$B/v1/ops-agent | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log((JSON.parse(s).agent||{}).state||'')}catch{console.log('')}})")
case "\$OS" in
  "") curl -s -o /dev/null -H "\$H" -H 'content-type: application/json' -d "{\"aiProfileId\":\"\$PID\"}" \$B/v1/ops-agent ;;
  FAILED) hbt retry Hatchabot >/dev/null 2>&1 ;;
esac
for _ in \$(seq 1 150); do
  R=\$(hbt list --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s).filter(x=>x.name!=='Hatchabot');console.log(a.filter(x=>x.state==='RUNNING').length+'/'+a.length)})" 2>/dev/null)
  O=\$(curl -s -H "\$H" \$B/v1/ops-agent | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log((JSON.parse(s).agent||{}).state||'none')}catch{console.log('?')}})")
  [ "\$R" = 1/1 ] && [ "\$O" = RUNNING ] && { echo "STATE ready agent=\$R manager=\$O"; break; }
  case "\$R\$O" in *FAILED*) echo "STATE failed agent=\$R manager=\$O"; break ;; esac
  sleep 5
done
echo "STATE last agent=\$R manager=\$O"
A=\$(hbt ask Helper 'Reply with the single word pong and nothing else.' 2>&1 | tail -1); echo "ASK \$A"
M=\$(hbt ask Hatchabot 'How many agents are on this machine? Answer with just the number.' 2>&1 | tail -1); echo "MANAGER \$M"
EOF
    L file push "$OUT/$u-agents.sh" "$VM/home/$u/agents.sh" --uid "${UIDOF[$u]}" --gid "${UIDOF[$u]}" --mode 0700 >/dev/null
    tenanti "$u" '~/agents.sh' >"$OUT/$u-agents.log" 2>&1
    grep -q '^STATE ready' "$OUT/$u-agents.log" && ok "$u: an agent and its Hatchabot agent both RUNNING (image pulled into the tenant's own store)" \
      || bad "$u: agents did not reach RUNNING — $(grep -E '^(STATE|FAIL)' "$OUT/$u-agents.log" | tail -1 | tr '\n' ' ')"
    grep -qi '^ASK.*pong' "$OUT/$u-agents.log" && ok "$u: the agent answered" || bad "$u: the agent did not answer — $(grep '^ASK' "$OUT/$u-agents.log" | cut -c1-120)"
    grep -qE '^MANAGER.*\b(2|two)\b' "$OUT/$u-agents.log" && ok "$u: the Hatchabot agent answered through its door (doorman → 10.0.2.2:${OPS[$u]})" \
      || bad "$u: the Hatchabot agent did not answer — $(grep '^MANAGER' "$OUT/$u-agents.log" | cut -c1-160)"
    # The memory cap reached the container: cgroup delegation works under the user slice.
    # Agent containers carry no role label (the doorman, manager jail and service containers do).
    CAP=$(tenant "$u" "export DOCKER_HOST=unix://\$XDG_RUNTIME_DIR/docker.sock; docker inspect \$(docker ps --format '{{.Names}} {{.Label \"hatchabot.role\"}}' | awk '\$2==\"\" && \$1 ~ /^$u-/ {print \$1}' | head -1) --format '{{.HostConfig.Memory}}' 2>/dev/null" | tr -d '\r')
    [ -n "$CAP" ] && [ "$CAP" != 0 ] && ok "$u: the agent's memory cap is enforced ($((CAP / 1048576)) MiB)" || bad "$u: no memory cap on the agent container (cgroup delegation?)"
  fi
done
[ -n "$CRED" ] && rm -f "$CRED"

# ---- 4. isolation ---------------------------------------------------------------
if [ "$TENANTS" -ge 2 ]; then
  a=t1; b=t2
  code() { L exec "$VM" -- su - "$1" -s /bin/bash -c "curl -s -o /dev/null -m 4 -w '%{http_code}' $2" 2>/dev/null | tr -d '\r'; }
  own=$(code $a "http://127.0.0.1:${PORT[$a]}/v1/config"); [ "$own" = 200 ] && ok "$a reaches its own Hatchabot (${PORT[$a]})" || bad "$a cannot reach its own port ${PORT[$a]} ($own)"
  x=$(code $a "http://127.0.0.1:${PORT[$b]}/v1/config"); [ "$x" = 000 ] && ok "$a's shell cannot reach $b's Hatchabot (${PORT[$b]})" || bad "$a's shell reached $b's port ${PORT[$b]} ($x)"
  x=$(code $a "http://127.0.0.1:${OPS[$b]}/"); [ "$x" = 000 ] && ok "$a's shell cannot reach $b's door (${OPS[$b]})" || bad "$a's shell reached $b's door ${OPS[$b]} ($x)"
  # …and from inside one of a's containers (its connections arrive as a, through slirp4netns).
  probe() { tenant "$a" "export DOCKER_HOST=unix://\$XDG_RUNTIME_DIR/docker.sock; docker run --rm --pull=never alpine sh -c 'wget -q -T4 -O /dev/null http://10.0.2.2:$1/v1/config 2>/dev/null && echo yes || echo no' 2>/dev/null || (docker pull -q alpine >/dev/null 2>&1; docker run --rm alpine sh -c 'wget -q -T4 -O /dev/null http://10.0.2.2:$1/v1/config 2>/dev/null && echo yes || echo no')" | tr -d '\r' | tail -1; }
  x=$(probe "${PORT[$a]}"); [ "$x" = yes ] && ok "$a's container reaches $a's Hatchabot at 10.0.2.2:${PORT[$a]}" || bad "$a's container cannot reach its own Hatchabot at 10.0.2.2:${PORT[$a]}"
  x=$(probe "${PORT[$b]}"); [ "$x" = no ] && ok "$a's container cannot reach $b's Hatchabot at 10.0.2.2:${PORT[$b]}" || bad "$a's container reached $b's Hatchabot at 10.0.2.2:${PORT[$b]}"
  x=$(code caddy "http://127.0.0.1:${PORT[$a]}/v1/config"); y=$(code caddy "http://127.0.0.1:${PORT[$b]}/v1/config")
  [ "$x" = 200 ] && [ "$y" = 200 ] && ok "the router user reaches both (${PORT[$a]}, ${PORT[$b]})" || bad "the router user cannot reach both ($x, $y)"
  x=$(L exec "$VM" -- sh -c "curl -s -o /dev/null -m 4 -w '%{http_code}' http://127.0.0.1:${PORT[$b]}/v1/config"); [ "$x" = 200 ] && ok "root reaches a tenant's port (the provisioner's smoke test)" || bad "root cannot reach ${PORT[$b]} ($x)"
  # The other tenant's Docker socket and home are closed.
  x=$(L exec "$VM" -- su - $a -s /bin/bash -c "ls /run/user/${UIDOF[$b]}/docker.sock /home/$b 2>&1 | head -1" | tr -d '\r')
  echo "$x" | grep -qi "permission denied\|No such" && ok "$a cannot see $b's Docker socket or home" || bad "$a can see $b's files: $x"
fi

L exec "$VM" -- sh -c 'free -m | sed -n 2p; for u in t1 t2; do printf "%s: " $u; systemctl show user-$(id -u $u).slice -p MemoryCurrent --value 2>/dev/null | awk "{printf \"%d MiB\\n\", \$1/1048576}"; done' >"$OUT/memory.txt" 2>/dev/null
echo
echo "── $PASS passed, $FAIL failed · memory: $(tr '\n' ' ' <"$OUT/memory.txt") · logs: $OUT ──"
printf '%s\n' "${RESULTS[@]}" >"$OUT/summary.txt"
[ "$FAIL" = 0 ]
