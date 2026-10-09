#!/usr/bin/env bash
# Install Hatchabot on a brand-new Linux machine, the way a stranger would, and
# check that everything a new owner does first works. Run it before promoting a
# release to stable, and now and then — it is the only test that starts from
# nothing (it found five first-run bugs the day it was written).
#
#   scripts/clean-install-test.sh                      # stable, then upgrade to latest
#   scripts/clean-install-test.sh --ai-source "Claude Max Setup Token"
#                                                      # …plus the full agent regression
#   scripts/clean-install-test.sh --channel latest --no-upgrade --keep
#   scripts/clean-install-test.sh --image ubuntu:22.04 --installer-url http://<this box>:8077/install.sh \
#       --bundle-base http://<this box>:8077 --channel v2.132.0-test --no-upgrade
#                                                      # a bundle built from a branch, served from here
#
# What it does, in a fresh Ubuntu 24.04 VM (LXD, on this machine):
#   1. the public one-liner from hatchabot.com on --channel (default stable),
#      answering its questions as a person would — including the log-out and
#      back in after Docker is installed;
#   2. `hatchabot doctor`; the first account, its recovery code, recovery with
#      it, and the sign-in page;
#   3. `hbt upgrade latest` (unless --no-upgrade) — the path every user updates by;
#   4. with --ai-source: that source's credential is copied into the VM (never
#      printed), and scripts/regress-autonomous.sh runs there — about eight
#      model turns on that source;
#   5. deletes the VM; --keep keeps it STOPPED (its qemu process exits),
#      --keep-running leaves it up. Logs stay in ~/hatchabot-clean-install/<time>/.
#
# Needs LXD (sudo snap install lxd && sudo lxd init --auto && sudo usermod -aG lxd $USER).
# On a machine that also runs Docker, the VM has no internet until Docker's
# firewall lets LXD's bridge through; the script checks and says how.
set -uo pipefail
CHANNEL=stable; UPGRADE=1; KEEP=0; AI_SOURCE=""; IMAGE=ubuntu:24.04; BUNDLE_BASE=""; UPGRADE_TO=latest
INSTALLER_URL="https://hatchabot.com/install.sh"
while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --no-upgrade) UPGRADE=0; shift ;;
    --keep) KEEP=1; shift ;;
    --keep-running) KEEP=1; KEEP_RUNNING=1; shift ;;   # leave the VM up afterwards (stop it by hand when done)
    --ai-source) AI_SOURCE="$2"; shift 2 ;;
    --installer-url) INSTALLER_URL="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;               # e.g. ubuntu:22.04 (glibc 2.35: the oldest the bundle supports)
    --bundle-base) BUNDLE_BASE="$2"; shift 2 ;;   # where the installer takes bundles from (HATCHABOT_BUNDLE_BASE)
    --upgrade-to) UPGRADE_TO="$2"; shift 2 ;;     # what `hbt upgrade` is asked for (default latest)
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1 (see --help)"; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VM="hb-clean-$(date +%m%d%H%M%S)"
OUT="$HOME/hatchabot-clean-install/$(date +%Y-%m-%d-%H%M%S)"
mkdir -p "$OUT"; chmod 700 "$OUT"
PASS=0; FAIL=0; RESULTS=()
ok()  { PASS=$((PASS + 1)); RESULTS+=("✓ $1"); echo "✓ $1"; }
bad() { FAIL=$((FAIL + 1)); RESULTS+=("✗ $1"); echo "✗ $1"; }

# lxc, whether or not this shell already has the lxd group.
L() { if id -nG | grep -qw lxd; then lxc "$@"; else sg lxd -c "lxc $(printf '%q ' "$@")"; fi; }
vm() { L exec "$VM" -- su - ubuntu -c "$1"; }       # as the new user, a fresh login each time
vmi() { vm "bash -ic $(printf '%q' "$1") 2>&1" | grep -vE '^bash: (cannot set terminal|no job control)'; }  # …with ~/.bashrc

command -v lxc >/dev/null || { echo "LXD is not installed. sudo snap install lxd && sudo lxd init --auto && sudo usermod -aG lxd \$USER"; exit 2; }
cleanup() {
  # Kept VMs are stopped unless asked otherwise, so no qemu process is left
  # holding memory after a run (2026-09-29).
  if [ "${KEEP_RUNNING:-0}" = 1 ]; then echo "kept RUNNING: $VM   (lxc exec $VM -- su - ubuntu · stop it with: lxc stop $VM)"; return; fi
  if [ "$KEEP" = 1 ]; then L stop "$VM" --force >/dev/null 2>&1; echo "kept, stopped: $VM   (lxc start $VM · lxc delete $VM --force)"; return; fi
  # A VM that stopped by itself (it happened mid-test on Ubuntu 22.04,
  # 2026-10-08): keep LXD's record of why before it goes.
  if ! L info "$VM" 2>/dev/null | grep -q 'Status: RUNNING'; then L info "$VM" --show-log >"$OUT/vm-stopped.log" 2>&1 && echo "the VM had stopped by itself: $OUT/vm-stopped.log"; fi
  L delete "$VM" --force >/dev/null 2>&1 && echo "deleted $VM"
}
trap cleanup EXIT

echo "Clean install test — $VM, channel $CHANNEL, logs in $OUT"
echo
# No input and a time limit: run from a background job, the lxc client once sat
# for 15 minutes after the VM was already up.
# images:<distro>/<release>[/<variant>] without an architecture: LXD may pick
# one this machine cannot run ("Requested architecture isn't supported",
# Debian 12 on an arm64 host, 2026-10-08) — name this machine's.
case "$IMAGE" in images:*)
  if ! printf '%s' "$IMAGE" | grep -qE '/(amd64|arm64)$'; then
    case "$(uname -m)" in aarch64|arm64) IMAGE="$IMAGE/arm64" ;; x86_64) IMAGE="$IMAGE/amd64" ;; esac
  fi ;;
esac
# The Debian 12 image is made here once from Debian's own (LXD's server has
# none for arm64): say how when it is missing.
case "$IMAGE" in hb-debian-*)
  L image info "$IMAGE" >/dev/null 2>&1 </dev/null || { bad "no local image $IMAGE — make it once with scripts/make-debian-test-image.sh"; exit 1; } ;;
esac
timeout 600 bash -c "$(declare -f L); L launch $IMAGE $VM --vm -c limits.cpu=4 -c limits.memory=8GiB -d root,size=40GiB" </dev/null >"$OUT/launch.log" 2>&1 \
  || { bad "launch a fresh $IMAGE VM ($(tail -1 "$OUT/launch.log"))"; exit 1; }
# Wait for cloud-init where the image has it (Ubuntu's, debian/12/cloud); a
# plain image has none and is ready once it answers.
for _ in $(seq 1 60); do
  if L exec "$VM" -- sh -c 'command -v cloud-init' >/dev/null 2>&1; then L exec "$VM" -- cloud-init status 2>/dev/null | grep -q done && break
  else L exec "$VM" -- true >/dev/null 2>&1 && break; fi
  sleep 5
done
ok "fresh $IMAGE VM ($(L exec "$VM" -- uname -m), $(L exec "$VM" -- getconf GNU_LIBC_VERSION))"

if ! L exec "$VM" -- sh -c 'timeout 8 ping -c1 -W5 1.1.1.1 >/dev/null 2>&1'; then
  bad "the VM has no internet"
  echo
  echo "  On a machine that runs Docker, its firewall drops LXD's bridge. Once per boot:"
  echo "    sudo iptables -I DOCKER-USER -i lxdbr0 -j ACCEPT"
  echo "    sudo iptables -I DOCKER-USER -o lxdbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT"
  exit 1
fi
# What the image already has (Ubuntu's cloud image ships git), so "gained" means gained.
BEFORE="$(L exec "$VM" -- sh -c 'for t in node git gcc; do command -v $t >/dev/null && echo $t; done' 2>/dev/null | tr '\n' ' ')"
L exec "$VM" -- sh -c 'DEBIAN_FRONTEND=noninteractive apt-get -qq update && DEBIAN_FRONTEND=noninteractive apt-get -qq install -y expect curl sudo' >"$OUT/expect.log" 2>&1
# The person installing: Ubuntu's image has an "ubuntu" user with sudo; Debian's
# has none, so make the same one (--image images:debian/12, 2026-10-08).
L exec "$VM" -- sh -c 'id ubuntu >/dev/null 2>&1 || { useradd -m -s /bin/bash -G sudo ubuntu && echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-ubuntu && chmod 440 /etc/sudoers.d/90-ubuntu; }' >>"$OUT/expect.log" 2>&1

# ---- 1. the installer, answered like a person ----------------------------------
cat >"$OUT/install.exp" <<EOF
# yes to each offer, Enter for the default sign-in
set timeout 1800
spawn bash -lc {HATCHABOT_CHANNEL=$CHANNEL ${BUNDLE_BASE:+HATCHABOT_BUNDLE_BASE=$BUNDLE_BASE} bash -c "\$(curl -fsSL $INSTALLER_URL)"}
expect {
  -re {\[y/N\] \$}      { send "y\r"; exp_continue }
  -re {Choose \[1\]: \$} { send "\r"; exp_continue }
  eof
}
catch wait result
exit [lindex \$result 3]
EOF
L file push "$OUT/install.exp" "$VM/home/ubuntu/install.exp" --uid 1000 --gid 1000 >/dev/null
INSTALLED=0
# A person re-runs after "log out and back in"; each run here is a fresh login.
for run in 1 2 3; do
  vm 'expect ~/install.exp' >"$OUT/install-$run.log" 2>&1
  if vm 'systemctl --user is-active hatchabot' 2>/dev/null | grep -q '^active'; then INSTALLED=$run; break; fi
  grep -q "Log out and back in" "$OUT/install-$run.log" || break
done
if [ "$INSTALLED" = 0 ]; then
  bad "install from $INSTALLER_URL — see $OUT/install-*.log"
  sed 's/\r//g' "$OUT"/install-*.log | grep -E '✗|ERR!|error' | tail -5 | sed 's/^/    /'
  exit 1
fi
ok "installed from $INSTALLER_URL ($INSTALLED run$([ "$INSTALLED" = 1 ] || echo s), the questions answered as a person would)"
# One prerequisite: a bundle install brings its own Node — none from the system.
if vm 'test -f ~/hatchabot/BUNDLE.json'; then
  ok "bundle install: $(vm 'cat ~/hatchabot/BUNDLE.json' | grep -oE '"platform":"[^"]+"|"node":"[^"]+"' | tr '\n' ' ')"
  # Docker's own packages recommend git, so on an image without it (Debian's)
  # the Docker step brings it: count only what came in another apt run
  # (/var/log/apt/history.log names each run's command, 2026-10-09).
  FROM_DOCKER="$(L exec "$VM" -- sh -c "awk '/^Commandline:/{d=/docker-ce/} /^Install:/&&d' /var/log/apt/history.log 2>/dev/null" </dev/null)"
  GAINED=""; for t in node git gcc; do case " $BEFORE " in *" $t "*) ;; *) vm "command -v $t" >/dev/null 2>&1 && ! printf '%s' "$FROM_DOCKER" | grep -qE "[ ,]$t:" && GAINED="$GAINED $t" ;; esac; done
  [ -z "$GAINED" ] && ok "the system gained no Node, git or compiler (had: ${BEFORE:-none})" || bad "the system gained:$GAINED"
fi
grep -q "Open Hatchabot:" "$OUT/install-$INSTALLED.log" && ok "it ends with the link: $(sed 's/\r//g' "$OUT/install-$INSTALLED.log" | grep -oE 'Open Hatchabot: +[^ ]+' | sed -n 1p | sed 's/#setup=.*/#setup=…/')" || bad "no link at the end of the install"
QS=$(sed 's/\r//g' "$OUT"/install-*.log | grep -c '\[y/N\] y')
[ "$QS" -ge 1 ] && ok "its questions were visible ($QS answered)" || bad "no question was visible to answer"

# ---- 2. what a new owner does first ----------------------------------------------
vmi 'hatchabot doctor' >"$OUT/doctor.log"
grep -q "^All good" "$OUT/doctor.log" && ok "hatchabot doctor: $(grep '^All good' "$OUT/doctor.log")" || bad "hatchabot doctor — $(grep '^✗' "$OUT/doctor.log" | sed -n 1,2p | tr '\n' ' ')"
vmi 'hbt help | sed -n 1p' | grep -q 'hbt is the same command' && ok "hatchabot and hbt are on the PATH" || bad "hbt is not on the PATH"
# doctor says "Release vX", or "Running vX, but vY is available locally".
ver() { grep -oE '(Release|Running) v[0-9.]+' | sed -n 1p | grep -oE 'v[0-9.]+'; }
REL=$(ver <"$OUT/doctor.log")

cat >"$OUT/firstrun.sh" <<'EOF'
#!/usr/bin/env bash
B=http://localhost:8080
# A bundle install has no system Node: use its own.
command -v node >/dev/null || PATH="$HOME/hatchabot/.node/bin:$PATH"
j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s);console.log(String(($1)(v)??''))}catch(e){console.log('')}})"; }
t() { [ "$2" = "$3" ] && echo "PASS $1" || echo "FAIL $1 (got '$2', want '$3')"; }
t "sign-in defaults to per-person accounts, first account not made yet" "$(curl -s $B/v1/config | j 'v=>v.authMode+"/"+v.needsSetup')" "accounts/true"
R=$(curl -s -c /tmp/ck -H 'content-type: application/json' -d '{"username":"owner","password":"first-password-here"}' $B/v1/local-accounts/bootstrap)
CODE=$(echo "$R" | j 'v=>v.recoveryCode')
t "the first account is the host owner" "$(echo "$R" | j 'v=>v.hostOwner')" "true"
t "and comes with a recovery code" "$(echo "$CODE" | grep -cE '^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$')" "1"
t "a second first-account is refused" "$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"username":"x","password":"another-password"}' $B/v1/local-accounts/bootstrap)" "403"
t "the recovery code sets a new password" "$(curl -s -H 'content-type: application/json' -d "{\"username\":\"owner\",\"code\":\"$CODE\",\"password\":\"second-password-here\"}" $B/v1/local-accounts/recover-with-code | j 'v=>v.ok&&!!v.recoveryCode')" "true"
t "the old password stops working" "$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"username":"owner","password":"first-password-here"}' $B/v1/login)" "401"
t "the new one works" "$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"username":"owner","password":"second-password-here"}' $B/v1/login)" "200"
t "a used code is spent" "$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d "{\"username\":\"owner\",\"code\":\"$CODE\",\"password\":\"third-password-here\"}" $B/v1/local-accounts/recover-with-code)" "401"
t "the sign-in page offers the recovery code" "$(curl -s $B/ | grep -q 'Use a recovery code' && echo yes)" "yes"
EOF
L file push "$OUT/firstrun.sh" "$VM/home/ubuntu/firstrun.sh" --uid 1000 --gid 1000 --mode 0755 >/dev/null
while IFS= read -r line; do
  case "$line" in PASS*) ok "${line#PASS }" ;; FAIL*) bad "${line#FAIL }" ;; esac
done < <(vm ./firstrun.sh 2>&1)

# ---- 3. the upgrade every user will run -----------------------------------------
if [ "$UPGRADE" = 1 ]; then
  vmi "${BUNDLE_BASE:+HATCHABOT_BUNDLE_BASE=$BUNDLE_BASE }hbt upgrade $UPGRADE_TO" >"$OUT/upgrade.log"
  NOW=$(vmi 'hatchabot doctor' | ver)
  if grep -qE "Now on|Already on" "$OUT/upgrade.log" && vm 'systemctl --user is-active hatchabot' | grep -q '^active'; then
    ok "hbt upgrade $UPGRADE_TO: $REL → $NOW"; REL="$NOW"
  else
    bad "hbt upgrade $UPGRADE_TO — $(tail -2 "$OUT/upgrade.log" | tr '\n' ' ')"
  fi
fi

# ---- 4. the full agent regression, on a real AI source ---------------------------
if [ -n "$AI_SOURCE" ]; then
  TOK=$(sed -n 's/^HATCHABOT_TOKEN=//p' "$HOME/.config/hatchabot/env" 2>/dev/null | tail -1)
  URL=$(sed -n 's/^HATCHABOT_URL=//p' "$HOME/.config/hatchabot/env" 2>/dev/null | tail -1); URL="${URL:-http://127.0.0.1:8080}"
  CRED="$OUT/.cred"; umask 077
  PID=$(curl -s -H "authorization: Bearer $TOK" "$URL/v1/ai-profiles" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);const p=r.find(p=>p.id==='$AI_SOURCE'||p.name==='$AI_SOURCE');console.log(p?p.id+' '+p.kind+' '+p.vendor+' '+p.model:'')})")
  if [ -z "$PID" ]; then bad "no AI source \"$AI_SOURCE\" on this machine (hbt sources)"; else
    set -- $PID
    curl -s -H "authorization: Bearer $TOK" "$URL/v1/ai-profiles/$1/credential" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);if(v.credential)process.stdout.write(v.credential)})" >"$CRED"
    KIND=$2; VENDOR=$3; MODEL=$4
    L file push "$CRED" "$VM/home/ubuntu/.cred" --uid 1000 --gid 1000 --mode 0600 >/dev/null; rm -f "$CRED"
    cat >"$OUT/aisetup.sh" <<EOF
#!/usr/bin/env bash
B=http://localhost:8080
# The bundle install puts no Node on the system (step 1 checks it): Hatchabot's own.
NODE="\$HOME/hatchabot/.node/bin/node"; [ -x "\$NODE" ] || NODE=node
curl -s -c /tmp/ck -o /dev/null -H 'content-type: application/json' -d '{"username":"owner","password":"second-password-here"}' \$B/v1/login
\$NODE -e 'const fs=require("fs");const c=fs.readFileSync(process.env.HOME+"/.cred","utf8").trim();const sub="$KIND"==="subscription";process.stdout.write(JSON.stringify(Object.assign({kind:sub?"subscription":"api_key",name:"Test source",vendor:"$VENDOR",model:"$MODEL"},sub?{oauthToken:c}:{apiKey:c})))' > /tmp/body.json
curl -s -b /tmp/ck -H 'content-type: application/json' --data @/tmp/body.json \$B/v1/ai-profiles >/dev/null
rm -f /tmp/body.json ~/.cred
T=\$(curl -s -b /tmp/ck -H 'content-type: application/json' -d '{"label":"clean-install-test"}' \$B/v1/cli-tokens | \$NODE -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
[ -n "\$T" ] || { echo "aisetup: no CLI token" >&2; exit 1; }
bash -ic "hatchabot login --token \$T" >/dev/null 2>&1
EOF
    L file push "$OUT/aisetup.sh" "$VM/home/ubuntu/aisetup.sh" --uid 1000 --gid 1000 --mode 0700 >/dev/null
    vm ./aisetup.sh >/dev/null 2>&1
    # The regression as it shipped in the release under test, not this checkout's copy.
    vmi 'HATCHABOT_CLI=hbt ~/hatchabot/scripts/regress-autonomous.sh' >"$OUT/regression.log"
    SUM=$(grep -E '^── [0-9]+ passed' "$OUT/regression.log")
    grep -qE '^── [0-9]+ passed, 0 failed' "$OUT/regression.log" && ok "autonomous-agent regression: ${SUM//─/}" \
      || { bad "autonomous-agent regression: ${SUM:-did not finish} — $(grep -E '^(✗|▸.*FAILED)' "$OUT/regression.log" | sed -n 1,2p | tr '\n' ' ')"
           vm 'journalctl --user -u hatchabot -n 200 --no-pager' >"$OUT/service.log" 2>&1; }
  fi
fi

echo
echo "── $PASS passed, $FAIL failed · ${REL:-release unknown} · logs: $OUT ──"
printf '%s\n' "${RESULTS[@]}" >"$OUT/summary.txt"
[ "$FAIL" = 0 ]
