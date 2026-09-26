# Several Hatchabots on one machine — rootless Docker per tenant

The shared host of Hatchabot Cloud (its `docs/architecture.md` §5): a Linux
user per tenant, each with its own rootless Docker daemon and its own
Hatchabot on its own ports. Useful to anyone hosting Hatchabot for someone
else, or keeping two installs apart on one box. `scripts/shared-host-test.sh`
builds it in a throwaway VM and checks it; this is what it does and why.

## What rootless Docker changes (measured in an LXD VM, 2026-09-25)

| | Root Docker | Rootless Docker |
|---|---|---|
| The host reaches a container's address (172.17.0.x) | yes | **no** — the bridge lives in the user's network namespace |
| `host.docker.internal:host-gateway` in a container | this machine | **the namespace's own bridge** — nothing of Hatchabot's listens there |
| A container reaches the host's loopback | at the bridge gateway | at **10.0.2.2** (slirp4netns), only with `DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false` |
| Ports published on `127.0.0.1` | on the host | on the host, **visible to every user** |
| `--memory`, `--pids-limit` | yes | only with cgroup delegation on `user@.service` |

Hatchabot detects a rootless daemon (`docker info` reports `name=rootless`) and:

- probes an agent's health on its published loopback port instead of its address;
- points every doorman's `host.docker.internal` at `10.0.2.2` (`HATCHABOT_HOST_ALIAS_IP` overrides);
- binds the management agent's door and the memory-search door on loopback
  (there is no bridge address to bind), which the doorman reaches through 10.0.2.2;
- tells an agent with peers to reach Hatchabot at `http://10.0.2.2:<PORT>`;
- says so in `hatchabot doctor`.

## One tenant, by hand

As root, once per host: Docker Engine, `uidmap slirp4netns dbus-user-session`,
Node 22, `build-essential python3 git`, cgroup delegation, and the
`br_netfilter` module (agents on one daemon are kept apart on the network,
which needs it; a rootless daemon cannot load it):

```
printf '[Service]\nDelegate=cpu cpuset io memory pids\n' > /etc/systemd/system/user@.service.d/delegate.conf
systemctl daemon-reload
modprobe br_netfilter && echo br_netfilter > /etc/modules-load.d/br_netfilter.conf
```

Keep the product's 3 GiB agent cap: an OpenClaw 2026.9 gateway idles around
700 MiB, the Hatchabot agent peaked at 1.45 GiB answering one question, and
a 1 GiB cap thrashed at its ceiling and restarted after every question
(measured 2026-09-25). Size the tenant's slice for what runs in it: the
control plane (~120 MiB), the memory search service (~500 MiB, capped at
2 GiB), the Hatchabot agent and each agent — about 3 GiB resident for one
agent, and a `MemoryHigh` below that throttles the whole slice into
uninterruptible sleep (load 42 on 6 CPUs). For now: no `MemoryHigh` at all
and `MemoryMax=8G` — a wall, never a throttle — with the 3 GiB cap per agent
inside it.

Per tenant (`t1`, on port 8101; give each tenant its own port set):

```
useradd -m -s /bin/bash t1 && loginctl enable-linger t1
systemctl set-property user-$(id -u t1).slice MemoryHigh=infinity MemoryMax=8G
su - t1
  mkdir -p ~/.config/systemd/user/docker.service.d
  printf '[Service]\nEnvironment=DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false\n' > ~/.config/systemd/user/docker.service.d/loopback.conf
  dockerd-rootless-setuptool.sh install
  HATCHABOT_YES=1 HATCHABOT_SETUP_SIGNIN=accounts HATCHABOT_SETUP_PORT=8101 \
  HATCHABOT_SETUP_ENV="DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
HATCHABOT_OPS_PORT=8191
HATCHABOT_EMBED_PORT=8091
HATCHABOT_GATEWAY_PORT_BASE=19100
HATCHABOT_PREFIX=t1
HATCHABOT_MAX_AGENTS_TOTAL=10
HATCHABOT_PUBLIC_URL=https://t1.example.com" \
  bash -c "$(curl -fsSL https://hatchabot.com/install.sh)"
  hbt accounts create owner --host-owner --cli-token --json
```

## One memory search service per host

Every tenant's Hatchabot would otherwise run its own engine (about 500 MiB
resident, capped at 2 GiB). One engine per host serves them all: the tenant
that runs it mints a **guest key** per neighbour, and the neighbour's
Hatchabot points its agents at that door instead of starting an engine.

```
# on the tenant that runs the service (t1)
hbt embedder guest-add t2          # prints the key once, with the three lines below
# in t2's .env, then restart t2's Hatchabot
HATCHABOT_EMBED_URL=http://10.0.2.2:8091/v1
HATCHABOT_EMBED_KEY=<the key>
HATCHABOT_EMBED_MODEL=embeddinggemma
```

The door treats a guest like an agent: its own key, its own rate limit
(`HATCHABOT_EMBED_PER_MIN`), its own log line — never a body. `hbt embedder
guest-rm t2` stops the key at once. Leave the service tenant's door port out
of its socket-owner rule (the key is the gate there), and give the service
tenant's slice the engine's 2 GiB. `scripts/shared-host-test.sh
--shared-embedder` builds this and checks that tenant 2 runs no engine.

## Keeping tenants apart

Host loopback on means a container can dial any `127.0.0.1` port on the
machine — another tenant's Hatchabot included. Connections from a tenant's
containers arrive as that tenant's user (slirp4netns runs as them), so one
socket-owner rule per tenant closes it, for the tenant's shell and its
containers alike, while the router (Caddy) and root still get through:

```
nft add table inet hb
nft add chain inet hb out '{ type filter hook output priority 0; }'
nft add rule inet hb out oif lo tcp dport { 8101, 8191, 8091, 19100-19199 } \
    meta skuid != { $(id -u t1), $(id -u caddy), 0 } reject with tcp reset
```

The other tenant's Docker socket (`/run/user/<uid>/docker.sock`) and home are
theirs alone by ordinary permissions. Tenants share a kernel; the Dedicated
grade exists for those who want a hypervisor between them and everyone else.
