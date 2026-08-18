# Agent runtime environment — tools, libraries, and data

`adopt` (§5.4-ish) brings an agent's **workspace** — its files and memory. It
does **not** bring the runtime environment a hand-built agent accreted on the
host: the interpreters and libraries its scripts need, the data directories it
read, and its scheduled jobs. This doc is how to reconstruct that on a managed
agent, and the shape a future declarative version will take.

## The runtime image is lean on purpose

`docker/Dockerfile.runtime` ships the base every agent shares: Node + OpenClaw,
the Claude Code CLI, **Python 3 + pip**, **git**, and **openssh-client**. It
ships **no** third-party Python packages. One image, patched and upgraded once,
serves the whole fleet — so it must not carry any single agent's app-specific
stack.

Per-agent tools go on the agent's **volume**, not in the image.

## Python libraries — per agent, on the volume

An agent that needs libraries installs them into a dir on its own volume:

```
pip install --target /home/node/.openclaw/pylibs <packages...>
```

The entrypoint (`docker/entrypoint.sh`) prepends `/home/node/.openclaw/pylibs`
to `PYTHONPATH` when it exists, so `python3 script.py` — how agents and their
cron jobs invoke scripts — imports them with no venv activation. Because the
volume is durable, the libraries survive rebuilds; because they're not in the
image, they don't bloat every other agent.

Note: `docker exec ... python3` bypasses the entrypoint and so won't see
`PYTHONPATH`. That's a testing artifact only — the gateway process and the cron
scripts it spawns as children do have it. To reproduce the real environment in a
one-off check, set it explicitly: `PYTHONPATH=/home/node/.openclaw/pylibs`.

## Data — three patterns, chosen per folder

**1. Read-only reference data** — broker exports, tax reports, anything the
agent only reads. Use an agent folder (⚙ Edit → Folders, or `agentclaw folders`):
it mounts the host dir read-only at `/data/<name>`. Read-only is enforced by the
kernel, and the refused-paths list still applies (see `ai-profiles.md`).

**2. Read-write versioned data the agent maintains** — a git repo the agent
edits and commits (e.g. holding-definition `.toml`s). Do **not** mount the host
working copy read-write: a container running with permissions disabled, reachable
by anyone who can message the bot, would write straight into your host
filesystem and its git working copy. Instead the agent **clones the repo into
its own volume** and pushes to the remote — host untouched, every change a
reviewable commit, blast radius contained to the one repo. Credential: a
**repo-scoped SSH deploy key with write access**, generated on the volume so
nothing account-wide enters the container:

```
ssh-keygen -t ed25519 -N "" -f /home/node/.openclaw/.ssh/<name>_deploy
# add the .pub to the repo as a WRITE deploy key (revocable, one repo only)
ssh-keyscan -t ed25519 github.com > /home/node/.openclaw/.ssh/known_hosts
git clone git@github.com:<owner>/<repo>.git /home/node/.openclaw/<repo>
git -C /home/node/.openclaw/<repo> config core.sshCommand \
  "ssh -i /home/node/.openclaw/.ssh/<name>_deploy -o IdentitiesOnly=yes \
   -o UserKnownHostsFile=/home/node/.openclaw/.ssh/known_hosts -o StrictHostKeyChecking=yes"
```

Point the agent's scripts at the clone path, not a `/data/<name>` mount.

**3. Local mutable data with no git** — a writable mount, only as an explicit,
owner-gated, loudly-warned opt-in. Prefer pattern 2 whenever the data is (or can
be) a git repo.

## Planned: declarative environments

The above is manual today. The intended product shape is to make an agent's
environment declarative and carried by `adopt`/`migrate`:

- a per-agent **tool/lib manifest** (`requirements.txt`/`setup.sh`) run on
  provision and rebuild, so the volume libs are reproducible and portable;
- **data sources** as first-class config — read-only mounts *and* git repos
  (URL + deploy key), cloned on provision;
- **crons carried on adopt**, with host paths rewritten to their in-container
  equivalents.

Until then, reconstruct the environment by hand as above; the Stock Advisor
migration is the worked example.
