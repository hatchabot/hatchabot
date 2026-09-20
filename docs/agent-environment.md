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

## Upgrading OpenClaw (the runtime image)

The OpenClaw version is pinned in `docker/Dockerfile.runtime`
(`ARG OPENCLAW_VERSION`) and baked into `hatchabot-runtime:latest`. Every agent
runs from that one image, so **the version is fleet-wide** — but adoption is
per-agent: an agent keeps its current image until you **Rebuild** it. (The catch:
once `:latest` moves, *any* Rebuild carries the new version — you can't rebuild an
agent onto the old one.)

Check where you stand — **⚙ Settings → Images**, or:

```
hatchabot runtime         # image's OpenClaw version vs the latest stable on npm
```

OpenClaw's stable is the npm `latest` dist-tag (there's also a conservative
`extended-stable` track). Upgrade the image from the host:

```
hatchabot upgrade-image                       # build + promote :latest to npm latest
hatchabot upgrade-image --version <X> --candidate   # build without promoting, to smoke-test
```

`--candidate` builds `hatchabot-runtime:<X>` but leaves `:latest` untouched, so
you can `HATCHABOT_IMAGE=hatchabot-runtime:<X> npm run e2e:docker` before
`docker tag …:<X> …:latest`. Because OpenClaw's `openclaw.json` schema moves
between releases, prefer the candidate path for a real version bump. After
promoting, each agent shows "update available"; **Rebuild** it to adopt the new
version, memory kept.

There is deliberately **no web button** for this: it's a slow, host-side,
fleet-wide docker build, so it lives in the CLI, not one click away in a browser.

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

## Secrets & environment variables — per agent

An agent's own tools often need a credential of their own — a market-data API
key, a webhook secret. Set these per agent in **⚙ Settings → Environment variables**
(or `POST /v1/agents/:id/env` with `{name, value}`):

- **Values are secrets.** They're stored encrypted in the SecretStore, **never**
  returned by the API, and write-only from the app — the list shows only names.
  To change one, remove it and add it again.
- **Injected at provision**, so they apply on the next **Rebuild**, like every
  other config.
- **Reserved names are refused by shape, not a fixed list.** This is a security
  boundary because an agent can run on a profile another account **shared**: the
  API rejects model-provider/credential families (`ANTHROPIC_*`, `OPENAI_*`,
  `AWS_*`, …), endpoint/proxy redirects (`ANTHROPIC_BASE_URL`, `*_PROXY`), and
  loader/TLS knobs (`LD_*`, `NODE_*`, `SSL_*`) — otherwise a borrower could point
  the shared credential at their own server and steal it. The managed AI env is
  also merged last, so it can never be shadowed.
- **Deleting the agent scrubs them** from the SecretStore along with its other
  credentials.

Caveat: env vars are **not yet carried by export/migrate** — the secret values
live in the SecretStore, not the portable workspace. After moving or importing an
agent, re-add its variables on the new host. (Carrying them is a follow-up.)

## Data — three patterns, chosen per folder

**1. Read-only reference data** — broker exports, tax reports, anything the
agent only reads. Use an agent folder (⚙ Settings → Data, or `hatchabot folders`):
it mounts the host dir read-only at `/data/<name>`. Read-only is enforced by the
kernel, and the refused-paths list still applies (see `ai-profiles.md`).

**2. Read-write versioned data the agent maintains** — a git repo the agent
edits and commits (e.g. holding-definition `.toml`s). Do **not** mount the host
working copy read-write: a container running with permissions disabled, reachable
by anyone who can message the bot, would write straight into your host
filesystem and its git working copy. Instead the agent works from its **own clone
on the volume** and pushes to the remote — host untouched, every change a
reviewable commit, blast radius contained to the one repo. This is now a
first-class **git data source**: the app generates the repo-scoped deploy key,
clones onto the volume, and wires up the SSH command for you — no manual
`ssh-keygen`/`git clone`. Add one via ⚙ Settings → Data (or
`POST /v1/agents/:id/data-sources`); see [docs/data-sources.md](data-sources.md).

**3. Local mutable data with no git** — a writable mount, only as an explicit,
owner-gated, loudly-warned opt-in. Prefer pattern 2 whenever the data is (or can
be) a git repo.

## Declarative environments — shipped and planned

**Data sources are already first-class config.** Read-only mounts, writable
folders, and git repos (URL + generated deploy key, cloned on provision) are
managed declaratively per agent — see [docs/data-sources.md](data-sources.md).

**Scheduled tasks are visible and manageable.** An agent's OpenClaw crons live in
its own gateway store on the durable volume (they survive rebuilds like MEMORY.md).
The app's **⏰ Tasks** button (per running agent) lists them and lets you
**add** (name + cron expression + timezone + the message fired at the agent,
v0.97.0), enable, disable, **run one now to test**, or delete — driven through
the in-container `openclaw cron` CLI, never the store directly.

**Crons are carried on adopt.** Scheduled tasks come across from the old
gateway's store with host paths rewritten to their in-container equivalents,
arriving **disabled** so you review them in ⏰ Tasks before they fire.

Still manual, and the intended next step for a fully declarative environment
carried by `adopt`/`migrate`: a per-agent **tool/lib manifest**
(`requirements.txt`/`setup.sh`) run on provision and rebuild, so the volume
libs (above) are reproducible and portable.

Until then, reconstruct the libraries by hand as above; the Stock Advisor
migration is the worked example.
