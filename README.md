# AgentClaw

**Run private AI agents for your family on your own hardware, reachable over Telegram.**

AgentClaw turns a machine you already own into a home for persistent AI agents.
Each agent lives in its own container, remembers things across conversations,
and is reachable from anywhere over Telegram — so the people using it never
install anything or see a terminal. You keep the hardware, the memory, and the
credentials.

It's a control plane for [OpenClaw](https://docs.openclaw.ai) agent runtimes:
AgentClaw handles provisioning, messaging identity, memory safety, membership,
and lifecycle; OpenClaw runs the agent.

```
   You (web app / CLI)          Family (Telegram)
            │                          │
      ┌─────▼──────────────────────────▼─────┐
      │        AgentClaw control plane       │
      └─────┬──────────────────────────┬─────┘
       ┌────▼────┐                ┌────▼────┐
       │ agent A │  containers    │ agent B │   ← one volume each:
       │ OpenClaw│  on your box   │ OpenClaw│      memory, config, sessions
       └─────────┘                └─────────┘
```

## What you get

- **Agents that remember.** Each has its own `SOUL.md` (who it is), `AGENTS.md`
  (how it works), and `MEMORY.md` (what it knows) — editable from the app, with
  automatic snapshots before every change so a bad edit is always undoable.
- **Telegram as the front door.** Family members chat with an agent like any
  other contact. No accounts, no apps, no setup on their side.
- **Invites with two tiers.** Send a link (or a QR code) for chat-only access,
  or have the invitee sign in so they can also log into AgentClaw and see the
  agents they belong to.
- **Adopt agents you already have.** Point AgentClaw at an existing OpenClaw
  workspace and it becomes a managed agent, whole workspace intact.
- **Let an agent read your files.** Share a folder with a specific agent and
  it can read your data — mounted read-only, per agent, never system paths or
  credential directories. Pair it with a local model and nothing leaves the
  machine at all.
- **A running history.** The app shows what has actually happened — agents
  rebuilt, members admitted, snapshots taken, runtimes that stopped answering.
- **Shared or private memory.** A family agent's memory is common to everyone
  in it — and everyone is told so. A personal agent's isn't.
- **Portability.** Move an agent to another AgentClaw server in one step — it
  is preflight-checked, transferred with its memory, members and Telegram
  identity, verified on arrival, and rolled back if anything fails. Or export
  it to a single file and import it wherever you like.
- **Bring your own AI — or none at all.** An Anthropic or Google Gemini API
  key, a Claude Pro/Max subscription on a machine where you're already logged
  in, or a **local model server you run yourself** (Ollama). The local path
  needs no credential of any kind: nothing stored, nothing injected, nothing
  leaving the machine.
- **Different agents can use different AIs.** The kitchen helper on a local
  model, the homework tutor on Claude — chosen per agent, changed any time.

## Requirements

- **Linux or macOS** with **Docker** (Docker Desktop is fine) and **Node.js 22+**
- **A Telegram account** (to create bots via [@BotFather](https://t.me/botfather) —
  about 60 seconds per agent, or pre-stock a pool so it's zero)
- **An AI**: an Anthropic or Google Gemini API key, the `claude` CLI logged in, **or** a local
  model server (see below) — the local path needs no account or credential
- A machine that stays on, if you want the agents to stay reachable

## Quick start

```sh
git clone https://github.com/cksci/agentclaw-ai.git agentclaw
cd agentclaw
./scripts/setup-host.sh
```

The script checks prerequisites, installs dependencies, generates a `.env`
(asking you to choose an app password), builds the agent runtime image,
installs a background service, and links the `agentclaw` CLI. It's safe to
re-run.

Then open **http://localhost:8080**, unlock with your password, and:

1. **Connect an AI source** (⚙ Settings → AI sources). If the `claude` CLI is logged in on this
   machine, it's one tap. On macOS, run `claude setup-token` and paste the
   token (see [docs/ai-profiles.md](docs/ai-profiles.md)). Otherwise paste an
   API key — or pick **Local model server** and point it at your own Ollama.
2. **Tap +** to create an agent. If the bot pool is empty you'll be asked for a
   BotFather token — the app walks you through it.
3. **Tap the Telegram link and say hi.** That first message claims the agent as
   yours. Then just chat.

To let others in, use **Invite…** on the agent card — send the link, or have
them scan the QR, or (if they're not on your network) send the agent's Telegram
link and approve them when they message it.

## The CLI

`agentclaw` speaks the same API as the web app, for scripting and remote
management. It's linked by `setup-host.sh`; configure it with
`~/.config/agentclaw/env` (`AGENTCLAW_URL`, `AGENTCLAW_PASSWORD`) or flags.
Every value in that file also works as a plain environment variable —
including `AGENTCLAW_TOKEN` and `AGENTCLAW_REFRESH_TOKEN`, for scripts that
shouldn't touch your config file. Env vars beat the file; flags beat both.

With per-user accounts, mint a token in the app (**⚙ Settings → Access →
New token**) and run `agentclaw login` — that works with any sign-in method,
including Google, which has no password for a CLI to use.

```sh
agentclaw list                          # state, model, last activity
agentclaw create "Kitchen Helper"       # incl. the BotFather step if needed
agentclaw logs "Kitchen Helper" -n 100
agentclaw snapshot "Kitchen Helper" --label "before the big edit"
agentclaw restore "Kitchen Helper" <snapshot-id>

# move an agent to another AgentClaw server, in one step
agentclaw servers add Desktop http://desktop:8080 <token-from-that-server>
agentclaw migrate "Kitchen Helper" Desktop

# or move it by file
agentclaw export "Kitchen Helper" -o kitchen.agentclaw
agentclaw --url http://desktop:8080 import kitchen.agentclaw
```

`agentclaw help` lists every command. See
[docs/moving-agents.md](docs/moving-agents.md) for the migration rules.

## Configuration

All via `.env` in the repo root (generated by `setup-host.sh`, never committed):

| Variable | Purpose |
|---|---|
| `AGENTCLAW_SECRET_KEY` | **Required.** Encrypts stored credentials. Losing it means re-entering every token. |
| `AGENTCLAW_PASSWORD` | App password (password auth mode). |
| `PORT` | HTTP port, default `8080`. |
| `AGENTCLAW_PUBLIC_URL` | Canonical URL used in invite links, e.g. a Tailscale hostname. |
| `AGENTCLAW_AUTH` | `password` (default) or `identity` — see below. |
| `AGENTCLAW_DB` | SQLite path, default `data/agentclaw.sqlite`. |
| `AGENTCLAW_IMAGE` | Runtime image tag, default `agentclaw-runtime:latest`. |
| `AGENTCLAW_PREFIX` | Docker name prefix. Change it to run **two installations on one host**. |
| `AGENTCLAW_GATEWAY_PORT_BASE` | First debug-UI port, default `19100`. Also for multi-install. |
| `AGENTCLAW_BACKUP_DIR` | Nightly backups, default `~/agentclaw-backups`. |
| `AGENTCLAW_BACKUP_KEEP_DAYS` | Backup retention, default `14`. |
| `AGENTCLAW_AGENT_MEMORY` | Per-agent container memory cap, default `2g`. |
| `AGENTCLAW_AGENT_PIDS` | Per-agent process limit, default `512`. |
| `AGENTCLAW_DOCKER_TIMEOUT_MS` | Docker command timeout, default `60000`. |
| `AGENTCLAW_RECONCILE_MS` | How often runtime state is re-checked, default `120000`. |
| `AGENTCLAW_BIND` | Listen address. Defaults to `0.0.0.0`, or `127.0.0.1` when no password is set. |

**Authentication.** By default AgentClaw uses one shared password — right for a
home install on a private network. Set `AGENTCLAW_AUTH=identity` to use real
per-user accounts via GCP Identity Platform (Google sign-in and/or
email/password) instead; that path needs `AGENTCLAW_GCP_PROJECT`,
`AGENTCLAW_IDENTITY_API_KEY`, and `AGENTCLAW_GOOGLE_CLIENT_ID`. Setup and
rationale in [docs/identity.md](docs/identity.md).

**Off-network access.** Agents reach Telegram outbound from wherever they run,
so chatting works anywhere with no port forwarding. Only AgentClaw's own web
pages need reaching, for which [docs/tailscale.md](docs/tailscale.md) describes
a Tailscale setup that opens nothing to the internet.

## Running on your own hardware

Agents can run entirely on a local model, with no credential and no outbound
traffic. Three things have to line up:

```sh
# 1. The server must listen where CONTAINERS can reach it. The host's own
#    loopback is not reachable from inside a container.
sudo systemctl edit ollama      # Environment="OLLAMA_HOST=0.0.0.0:11434"

# 2. Keep the model resident, and only one at a time. Without this the model
#    unloads after 5 minutes and every message pays a ~10s reload.
#    Environment="OLLAMA_KEEP_ALIVE=-1"
#    Environment="OLLAMA_MAX_LOADED_MODELS=1"
sudo systemctl restart ollama

# 3. Pull a model. Prefer 8-bit: 4-bit quantization measurably degrades
#    structured output, which is exactly the tool-calling an agent depends on.
ollama pull qwen3.6:27b-q8_0
```

Then add the AI source in **⚙ Settings → AI sources** (pick **Local model
server**), using the docker bridge address (`http://172.17.0.1:11434/v1`) —
*not* `localhost`. AgentClaw
checks reachability and that the model exists before saving.

Expect a large model to occupy tens of GB of RAM while resident and to take
~10s to load the first time. Because only one fits at a time, agents on two
*different* local models will evict each other; the app warns you before you
set that up. A practical mix is most agents on a hosted model and one on
local. Details and tuning: [docs/ai-profiles.md](docs/ai-profiles.md).

## How it works

```
src/
  domain/       Agent, AIProfile, Membership + the state machine
  store/        SQLite persistence (one file to swap for Postgres)
  secrets/      SecretStore interface; local AES-256-GCM implementation
  providers/    RuntimeProvider interface + Mock and LocalDocker providers
  channels/     ChannelProvisioner: bot pool → paste-token composite
  openclaw/     Surgical openclaw.json patching + workspace seeding
  orchestrator/ Provisioning, claim, invites, members, snapshots, transfer
  api/          Fastify routes, auth modes, identity verification
  cli.ts        The agentclaw command
web/            The app and the invitee join page: single files, no build step
```

Four interfaces are load-bearing and were written before anything needed them:
`RuntimeProvider` (so other hosts slot in without touching the control plane),
`ChannelProvisioner` (so other messengers do too), `SecretStore` (so a cloud
secret manager replaces the local one), and the auth-mode seam (so identity
providers swap without rewriting routes).

Design decisions worth knowing before you read the code:

- **Telegram bots are leased, not minted.** Telegram has no API to create bots,
  so a pool of pre-made bots is leased to agents (`scripts/pool-add.ts` stocks
  it) with a paste-your-own-token fallback.
- **`openclaw.json` is patched, never templated.** Its schema moves between
  releases; AgentClaw emits a handful of `openclaw config set` commands for
  only the paths it owns. See `src/openclaw/configWriter.ts`.
- **Containers are cattle, volumes are not.** All durable state lives on the
  agent's volume. Rebuild replaces the container and keeps memory; only Delete
  purges, and it makes you type the agent's name.
- **Credentials stay put.** A Claude subscription is bind-mounted in place
  rather than copied; API keys are encrypted at rest and resolved only at boot.

## Operations

```sh
./scripts/restart.sh                  # restart (systemd or launchd)
./scripts/backup-volumes.sh           # manual backup; also runs nightly
./scripts/build-runtime-image.sh      # rebuild the agent image
npm test                              # unit tests + web syntax check
```

Logs: `journalctl --user -u agentclaw -f` (Linux) or `tail -f data/server.log`
(macOS).

**Never `cp` a running database.** AgentClaw uses SQLite in WAL mode, so an
un-checkpointed `data/agentclaw.sqlite` copies as an *empty* file. Use
`./scripts/backup-volumes.sh` (which uses SQLite's online backup API) or stop
the service first — shutdown checkpoints the WAL.

**What a backup contains.** The nightly run (a systemd user timer on Linux, a
launchd daily job on macOS — both installed by `setup-host.sh`) writes a dated
directory under `AGENTCLAW_BACKUP_DIR` holding the control-plane database
(agent registry, memberships, encrypted credentials, memory snapshots), a copy
of `AGENTCLAW_SECRET_KEY` — without which those credentials can't be decrypted
— and one tarball per agent volume (the agent's memory and OpenClaw state).
Restoring the database alone brings back everything AgentClaw knows; restoring
a volume brings back what an agent knows. Backups are as sensitive as the
system itself and live in a `0700` directory.

**Restoring from backup.** Stop the service first (`./scripts/restart.sh`
knows how to start it again afterwards; agent containers should be stopped
too). Then, from the dated backup directory you want:

1. Copy `agentclaw.sqlite` over `data/agentclaw.sqlite` (or wherever
   `AGENTCLAW_DB` points).
2. Check that `.env` still has the `AGENTCLAW_SECRET_KEY` line saved in the
   backup's `secret-key.env` — put it back if not. Without that exact key,
   every stored bot token and API key in the database is unrecoverable, and
   changing it also invalidates existing sessions (everyone signs in again).
3. Restore each agent volume you need, with that agent stopped:

   ```sh
   docker run --rm -v <volume>:/data -v <backup-dir>:/in:ro \
     agentclaw-runtime:latest bash -c 'cd /data && tar xzf /in/<volume>.tgz'
   ```

4. Restart the service. If an agent comes up confused — wrong model, stale
   config — use **Rebuild**: the container is disposable, the volume you just
   restored is not.

## Status and limitations

Working and used daily by its author, but young — expect rough edges.

- **SQLite, single node.** Fine for a household; Postgres is the intended path
  for anything larger.
- **Telegram only.** The channel abstraction exists for others; nothing else is
  implemented.
- **Cloud hosting isn't built.** AgentClaw runs on machines you own.
  [docs/identity.md](docs/identity.md) and the architecture are shaped for it,
  but the hosted path is deliberately deferred.
- **Not audited by a third party.** It has been reviewed for the obvious
  classes (authorization, injection, secret handling) and has tests for them,
  but it holds real credentials — run it on a network you trust.
- **Agents are powerful, and that is the design.** Each runs Claude Code with
  permission prompts disabled, a shell, and unrestricted outbound internet. On
  the subscription path your `~/.claude` credential directory is bind-mounted
  into every agent container read-write (the CLI refreshes tokens in place).
  A prompt injection — from a member, or from a page an agent fetches — is
  therefore a real risk to that credential. Give agents to people you trust,
  and prefer an API-key profile if that tradeoff bothers you.

## License

MIT — see [LICENSE](LICENSE).
