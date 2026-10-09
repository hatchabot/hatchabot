#!/usr/bin/env bash
# Make the local LXD image "hb-debian-12": Debian 12 as a VM on this machine's
# CPU, for the clean-install-debian-12 live test (scripts/live.mjs).
#
#   scripts/make-debian-test-image.sh            # once; again to refresh it
#
# LXD's image server has no arm64 VM images, so the test could only run on an
# x86 machine (2026-10-09). Debian publishes its own cloud images for both
# CPUs. This takes the official "nocloud" one, checks it against Debian's
# SHA512SUMS, imports it, and boots it once to:
#   - install LXD's guest agent (what `lxc exec` talks to; LXD's own images
#     ship it), logging in as root on the serial console — the nocloud image
#     has no cloud-init and a passwordless root console for exactly this;
#     Debian's cloud-init images ignored LXD's cloud-init drive here;
#   - add a boot-time unit that grows the root partition to the VM's disk
#     (cloud-init's job elsewhere), and lock root's password;
# then saves it as hb-debian-12. The test launches it like any other image:
# --image hb-debian-12.
set -euo pipefail
ALIAS=hb-debian-12
BASE_URL=https://cloud.debian.org/images/cloud/bookworm/latest
case "$(uname -m)" in aarch64|arm64) ARCH=arm64; LXD_ARCH=aarch64 ;; x86_64) ARCH=amd64; LXD_ARCH=x86_64 ;; *) echo "unsupported CPU $(uname -m)"; exit 2 ;; esac
FILE="debian-12-nocloud-$ARCH.qcow2"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/hatchabot-test-images"
VM="hb-debian-prep-$$"
mkdir -p "$CACHE"

# No input: with an open stdin the lxc client can sit forever (it did here,
# and in clean-install-test.sh, 2026-10-08).
L() { if id -nG | grep -qw lxd; then lxc "$@" </dev/null; else sg lxd -c "lxc $(printf '%q ' "$@")" </dev/null; fi; }
WORK="$(mktemp -d)"
cleanup() { L delete "$VM" --force >/dev/null 2>&1 || true; L image delete "$ALIAS-base" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

echo "1. Debian's image ($FILE)"
want="$(curl -fsSL --max-time 60 "$BASE_URL/SHA512SUMS" | awk -v f="$FILE" '$2 == f { print $1 }')"
[ -n "$want" ] || { echo "Debian's SHA512SUMS does not list $FILE"; exit 1; }
have="$( [ -f "$CACHE/$FILE" ] && sha512sum "$CACHE/$FILE" | cut -d' ' -f1 || true)"
if [ "$have" != "$want" ]; then
  curl -fsSL --max-time 1800 -o "$CACHE/$FILE.part" "$BASE_URL/$FILE"
  [ "$(sha512sum "$CACHE/$FILE.part" | cut -d' ' -f1)" = "$want" ] || { rm -f "$CACHE/$FILE.part"; echo "checksum mismatch on $FILE"; exit 1; }
  mv "$CACHE/$FILE.part" "$CACHE/$FILE"
fi
echo "   checksum matches Debian's SHA512SUMS"

echo "2. import it into LXD"
cat >"$WORK/metadata.yaml" <<EOF
architecture: $LXD_ARCH
creation_date: $(date +%s)
properties:
  description: Debian 12 $ARCH (official nocloud image, with LXD's agent)
  os: debian
  release: bookworm
  architecture: $ARCH
EOF
tar -C "$WORK" -czf "$WORK/metadata.tar.gz" metadata.yaml
L image delete "$ALIAS-base" >/dev/null 2>&1 || true
L image import "$WORK/metadata.tar.gz" "$CACHE/$FILE" --alias "$ALIAS-base" >/dev/null

echo "3. boot it and install LXD's agent from its console"
L init "$ALIAS-base" "$VM" --vm -c limits.cpu=2 -c limits.memory=2GiB -c security.secureboot=false -d root,size=4GiB >/dev/null
L start "$VM"
# The agent's installer is on the config share (9p) every LXD VM gets.
cat >"$WORK/console.py" <<'EOF'
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp('sh', ['sh', '-c', sys.argv[1]])  # the "lxc console <vm>" command
buf = b''
def wait_for(token, secs):
    global buf
    end = time.time() + secs
    while time.time() < end:
        if select.select([fd], [], [], 1)[0]:
            try: buf += os.read(fd, 4096)
            except OSError: return False
            if token in buf: return True
    return False
for _ in range(36):  # the boot: up to about six minutes
    os.write(fd, b'\r')
    if wait_for(b'login:', 10): break
os.write(fd, b'root\r')
ok = wait_for(b'# ', 30)
if ok:
    os.write(fd, b'mkdir -p /mnt/c && (mount -t 9p config /mnt/c || mount -t virtiofs config /mnt/c) && cd /mnt/c && ./install.sh && cd / && umount /mnt/c && systemctl start lxd-agent && echo AGENT-INSTALLED-OK\r')
    ok = wait_for(b'AGENT-INSTALLED-OK\r', 180)
os.write(fd, b'exit\r'); time.sleep(1); os.kill(pid, 9)
if not ok: sys.stdout.write(buf.decode('utf-8', 'replace')[-2000:])
sys.exit(0 if ok else 1)
EOF
if id -nG | grep -qw lxd; then CONSOLE="lxc console $VM"; else CONSOLE="sg lxd -c 'lxc console $VM'"; fi
python3 "$WORK/console.py" "$CONSOLE" || { echo "could not install the agent from the console"; exit 1; }
for i in $(seq 1 12); do L exec "$VM" -- true >/dev/null 2>&1 && break; [ "$i" = 12 ] && { echo "the agent does not answer"; exit 1; }; sleep 5; done
echo "   $(L exec "$VM" -- sh -c '. /etc/os-release; echo "$PRETTY_NAME, $(uname -m), glibc $(getconf GNU_LIBC_VERSION | cut -d" " -f2)"')"

echo "4. grow the root at boot, lock root, save it as $ALIAS"
cat >"$WORK/hb-growroot" <<'EOF'
#!/bin/sh
# Grow the root partition and filesystem to the VM's disk at boot: the
# hb-debian-12 test image has no cloud-init to do it
# (scripts/make-debian-test-image.sh).
src=$(findmnt -no SOURCE /)
disk=/dev/$(lsblk -no PKNAME "$src")
part=$(cat "/sys/class/block/$(basename "$src")/partition")
growpart "$disk" "$part" || true
resize2fs "$src"
EOF
cat >"$WORK/hb-growroot.service" <<'EOF'
[Unit]
Description=Grow the root filesystem to the disk
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/hb-growroot

[Install]
WantedBy=multi-user.target
EOF
L exec "$VM" -- sh -c 'DEBIAN_FRONTEND=noninteractive apt-get -qq update && DEBIAN_FRONTEND=noninteractive apt-get -qq install -y cloud-guest-utils >/dev/null'
L file push "$WORK/hb-growroot" "$VM/usr/local/sbin/hb-growroot" --mode 0755 >/dev/null
L file push "$WORK/hb-growroot.service" "$VM/etc/systemd/system/hb-growroot.service" >/dev/null
# Each launch must be a new machine (a new machine-id); root logs in only
# through lxc exec.
L exec "$VM" -- sh -c 'systemctl enable -q hb-growroot.service && passwd -lq root && apt-get clean && truncate -s0 /etc/machine-id && rm -f /var/lib/dbus/machine-id'
L stop "$VM"
L image delete "$ALIAS" >/dev/null 2>&1 || true
L publish "$VM" --alias "$ALIAS" description="Debian 12 $ARCH with LXD's agent (scripts/make-debian-test-image.sh)" >/dev/null
echo "   done: the live test runs it with --image $ALIAS"
