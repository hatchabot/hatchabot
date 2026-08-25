# Setting up a runner

A **runner** is any machine this cluster runs agents on besides the control
plane itself — a laptop, a spare box, a cloud VM. The control plane drives its
Docker daemon remotely (usually over SSH); the runner needs **no AgentClaw
install** of its own.

The web app walks you through this (⚙ Settings → Runners → Add a runner).
This page is the same flow with the reasoning and the troubleshooting.

## What a runner needs

1. **Docker** installed and running.
2. **SSH** reachable from the control plane (macOS: System Settings →
   Sharing → Remote Login; Linux: `sshd`). A tailnet address works great.
3. The control plane's **runner key authorized** — step 2 below.
4. The **runtime image** (`agentclaw-runtime`) present on its daemon — the
   app's *Install image* button copies it over if missing.

## The three steps

### 1. Prepare the runner

Install Docker, enable SSH. That's the only inherently manual part.

### 2. Authorize this control plane

In ⚙ Settings → Runners, tap **"show the command"** and paste the snippet
into a terminal *on the runner*. It does three idempotent things:

- appends the control plane's **dedicated public key** to
  `~/.ssh/authorized_keys` (the key is generated server-side on first use —
  `~/.ssh/agentclaw_runner` — passphrase-less, used only for runners);
- adds Docker's usual directories to `PATH` for **non-interactive** shells
  (`~/.zshenv`, `~/.bashrc`) — on macOS, `docker -H ssh://…` otherwise fails
  with *"command not found"* because sshd's default PATH is `/usr/bin:/bin`;
- self-checks that `docker` answers.

### 3. Add the address

Enter a name and `ssh://user@host` (or `tcp://host:2376` if you've set up a
TLS-guarded TCP socket yourself). On add, the control plane automatically:

- pins its dedicated key for that hostname in `~/.ssh/config`
  (`IdentitiesOnly yes`) — this is what makes the **headless service** work:
  without it, ssh offers your personal keys first, and a passphrase-protected
  default key exhausts the server's auth attempts with *"Too many
  authentication failures"* the moment no ssh-agent is around;
- sets `StrictHostKeyChecking accept-new` for that host, so the first
  connection doesn't stall on a host-key prompt nobody can answer;
- pings the daemon and checks for the runtime image.

If the row says **runtime image missing**, tap **Install image** — the control
plane streams its local image over (`docker save | docker -H … load`). It's a
multi-GB copy; expect minutes on a tailnet.

## What runs on a runner

- Agents using an **API-key** AI source, or a **Claude Max setup-token**
  source. The machine-login Max source stays on the control plane machine —
  its `~/.claude` mount can't cross daemons (see
  [ai-profiles.md](ai-profiles.md)).
- **Host-folder data sources don't follow**: a folder path names the control
  plane's disk, so remote agents skip those mounts. Git-repo data sources
  work anywhere (they live on the agent's own volume).
- The agent's debug Control UI publishes on the *runner's* loopback, so the
  gateway button in the app won't reach it. Everything else — Telegram,
  health checks, logs, Move — works normally (health and logs go over the
  Docker connection, and the Telegram gateway polls outbound).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Connection refused` on add | SSH isn't enabled on the runner, or a firewall blocks 22. |
| `Permission denied` / `Too many authentication failures` | The step-2 snippet wasn't run (key not authorized), or an old hand-made config block shadows the managed one. Re-run step 2; check `~/.ssh/config` on the control plane for a `Host <runner>` block with `IdentitiesOnly yes`. |
| `command not found: docker` | The runner's non-interactive PATH misses Docker (classic on macOS). Re-run the step-2 snippet; confirm with `ssh user@runner 'docker version'` — from a plain shell, *not* a terminal where an ssh-agent may paper over it. |
| Reachable in your terminal, unreachable in the app | Your shell has an ssh-agent the service doesn't. The managed config block avoids agents entirely — verify with `env -i HOME=$HOME docker -H ssh://user@runner version`. |
| Provision fails with "workspace failed" | Runtime image missing or stale on the runner — use **Install image**, then Retry. |

## Removing a runner

**Drain** it (stops every agent), **Move** the agents you're keeping to
another runner, then **Remove**. The managed `~/.ssh/config` block and the
runner-side authorized key are left in place (harmless); delete them by hand
if you want a clean break.
