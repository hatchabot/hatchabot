# Hatchabot

**Run private AI agents for your family on your own hardware, reachable from
Telegram or the app itself** — with Slack and Discord built and coming next.

Hatchabot turns a machine you already own into a home for persistent AI agents.
Each agent lives in its own container, remembers things across conversations,
and is reachable from anywhere over the messaging app you choose — so the
people using it never install anything or see a terminal. You keep the
hardware, the memory, and the credentials.

It's a control plane for [OpenClaw](https://docs.openclaw.ai) agent runtimes:
Hatchabot handles provisioning, messaging identity, memory safety, membership,
and lifecycle; OpenClaw runs the agent.

**It also runs itself.** Every installation can create a **Hatchabot agent** —
an ordinary agent, on whichever AI source you have, whose job is your fleet.
Ask it in plain words and it reads everything (health, logs, usage, files) and
*proposes* the change: a card you confirm in the app, executed with your
sign-in, never with anything the agent holds. It lives in a network jail with a
propose-only key, tells you what happened afterwards, and — given its own
Telegram bot — messages your phone when something is waiting. See
[docs/ops-agent-design.md](docs/ops-agent-design.md).

**New here or catching up?** [docs/features.md](docs/features.md) is a
task-first tour of everything the app does today — creating, training, moving,
adopting, backing up, and operating a fleet of agents.

```
   You (web app / CLI)     Family (Telegram — Slack/Discord next)
            │                          │
      ┌─────▼──────────────────────────▼─────┐
      │        Hatchabot control plane       │
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
- **A front door they already have.** Family members chat with an agent like
  any other contact on Telegram — no AI account, no app, no setup on their
  side (Slack and Discord are built and come next). An agent can also have no
  chat app at all and be talked to in the Hatchabot app.
- **Private by default.** A stranger who finds an agent's bot gets silence:
  only people you invited, or who already use one of your agents, get
  through. Everyone who uses the web app signs in as themselves, and a
  forgotten password is a link you send them — or one "Forgot password?" sends
  to their own Telegram.
- **A manager agent.** Your Hatchabot agent reads the fleet and proposes
  changes in plain words; every change is a card you confirm. It runs on
  whichever AI source you already have.
- **Invites with two tiers.** Send a link (or a QR code) for chat-only access,
  or have the invitee sign in so they can also log into Hatchabot and see the
  agents they belong to.
- **Adopt agents you already have.** Point Hatchabot at an existing OpenClaw
  workspace and it becomes a managed agent, whole workspace intact.
- **Give an agent your data.** Per-agent **data sources**: share a folder
  read-only (never system paths or credential directories), a writable folder,
  or a first-class **git repo** the agent clones onto its own volume and commits
  to — so every change is a reviewable commit, not a write into your disk. A public
  repo needs no key at all: tick **Public repo** and it is cloned read-only over https. Pair
  it with a local model and nothing leaves the machine at all.
- **Organize your fleet.** Sort agents into named groups and arrange them: drag a
  card by its ⠿ grip or a name in the left legend (drop it in another group to move
  it there), ▲5 / ▼5 to jump five places, pick a position number under the arrows (1 = top),
  Shift-click any arrow to go to the top or bottom, or sort a group — or every group — A→Z.
- **Manage scheduled tasks.** See an agent's cron jobs (⏰ Tasks), enable or
  disable them, run one now to test, or delete one — no shelling into the
  container. Tasks live on the agent's durable volume and survive rebuilds.
- **Give an agent its own secrets.** Set per-agent environment variables (an API
  key a script needs) in ⚙ Settings — stored encrypted, write-only, and injected on
  the next rebuild. Hatchabot's own AI credentials always take precedence.
- **See what each agent is using.** A per-agent **📊 Usage** view shows
  cumulative tokens by model and session count, with honest billing context —
  *included* for a subscription, *no API cost* for a local model, or the model's
  price for an API-key agent. Usage, not a fabricated bill.
- **See what your AI plan is spending.** Each AI source reports requests and
  tokens for the last 5 hours and 7 days, a 7-day chart, and which agents are
  heaviest — measured from the agents' own model calls. When a provider starts
  refusing calls, a banner names the source and the affected agents, so a quiet
  fleet has an explanation instead of a mystery.
- **Know it's really answering.** A per-agent **❤️ Health** check probes the live
  gateway — event loop, Telegram connection (with last error), plugin errors — so
  you can tell a truly-running agent from one that's *listed* as running but has
  quietly stopped responding.
- **A running history.** The app shows what has actually happened — agents
  rebuilt, members admitted, snapshots taken, runtimes that stopped answering.
  A recent-activity card summarizes it; **See all →** opens the full audit log,
  filterable by agent and showing each event's recorded detail. The management
  bot can read the same timeline (`list_events`).
- **Shared or private memory.** A family agent's memory is common to everyone
  in it — and everyone is told so. A personal agent's isn't.
- **Portability.** **Rehost** an agent to another Hatchabot server in one step —
  it is preflight-checked, transferred with its memory, members and Telegram
  identity, verified on arrival, and rolled back if anything fails. Or **Download** a copy
  to a single file and **Restore** it wherever you like.
- **Share a trained agent.** Built a good one? **Share** it as a template — its
  persona, instructions and memory, with *no* bot token or members — and send
  the file (it's safe to email). **Import** stands up a fresh copy the recipient
  runs with their *own* bot and their *own* people.
- **Bring your own AI — or none at all.** An Anthropic, OpenAI or Google
  Gemini API key, a Claude Pro/Max subscription on a machine where you're
  already logged in, or a **local model server you run yourself** (Ollama). The local path
  needs no credential of any kind: nothing stored, nothing injected, nothing
  leaving the machine.
- **Different agents can use different AIs — and different models.** The
  kitchen helper on a local model, the homework tutor on Claude — chosen per
  agent, changed any time. One Claude source can drive a cheap model for simple
  agents and a top model for the demanding ones; each agent picks from that
  source's model list, or follows its default.

## Requirements

- **Linux or macOS** with **Docker** (Docker Desktop is fine) and **Node.js 22+**
- **A Telegram account** (to create bots via [@BotFather](https://t.me/botfather) —
  about 60 seconds per agent, or pre-stock a pool so it's zero)
- **An AI**: an Anthropic, OpenAI or Google Gemini API key, the `claude` CLI logged in, **or** a
  local model server (see below) — the local path needs no account or credential
- A machine that stays on, if you want the agents to stay reachable

## Quick start

> New here? **[docs/quickstart.md](docs/quickstart.md)** is the 15-minute path to a first agent (Telegram + Claude included). **[docs/why-hatchabot.md](docs/why-hatchabot.md)** explains the philosophy and how this differs from a chat app; **[docs/pitch.md](docs/pitch.md)** is the short pitch. **[docs/deck/hatchabot-deck.pdf](docs/deck/hatchabot-deck.pdf)** is the slide deck.

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/hatchabot/hatchabot/main/install.sh)"
```

(or by hand: `git clone https://github.com/hatchabot/hatchabot.git hatchabot && cd hatchabot && git checkout "$(git describe --tags "$(git rev-list --tags --max-count=1)")" && ./scripts/setup-host.sh`)

The script checks prerequisites, installs dependencies, generates a `.env`
(asking how people will sign in — an account for each person is the default, a single shared password the other choice), pulls the pre-built agent runtime image (or builds it if the pull fails),
installs a background service, and links the `hatchabot` CLI. `hatchabot doctor` checks the result. It's safe to
re-run — and re-running it is how you **upgrade**.

**Release channels.** The installer takes the **`stable`** release unless told
otherwise, and remembers the channel so an upgrade stays on it:

| Channel | What it is |
|---|---|
| `stable` (default) | what new users get; moved deliberately, after a release has been in use for a while |
| `beta` | the next stable, for people willing to try it first |
| `latest` | the newest tagged release, whatever it is |
| `v2.30.3` | exactly that release, and stay there |

```sh
HATCHABOT_CHANNEL=beta bash -c "$(curl -fsSL https://hatchabot.com/install.sh)"
curl -fsSL https://hatchabot.com/install.sh | bash -s -- latest
```

`HATCHABOT_DRY_RUN=1` says which release it would install and stops. Releases
and their notes: [github.com/hatchabot/hatchabot/releases](https://github.com/hatchabot/hatchabot/releases).

**Uninstall** with `./scripts/uninstall.sh` — it reverses the install: stops and
removes the service (systemd units or launchd plists), unlinks the CLI, and
**stops** every agent, including the Hatchabot agent itself. Nothing you would
miss is deleted: the containers are stopped rather than removed, and the agent
volumes, the database, the backups and the runtime image all stay, so
re-running `setup-host.sh` brings the same fleet back and you start them
again. `--purge` is the clean slate
(volumes, database, images, the docker network, `.env`), `--backups` takes the
backup sets too, and both ask you to type `purge` first. Telegram bots can only
be deleted at @BotFather → `/mybots` → `/deletebot`.

Then open **http://localhost:8080** on that machine — with accounts you create your own there and become its owner; with a shared password you unlock with it — and:

1. **Connect an AI source** (⚙ Settings → AI sources). If the `claude` CLI is logged in on this
   machine, it's one tap. On macOS, run `claude setup-token` and paste the
   token (see [docs/ai-profiles.md](docs/ai-profiles.md)). Otherwise paste an
   API key — or pick **Local model server** and point it at your own Ollama.
2. **Tap +** to create an agent. If the bot pool is empty you'll be asked for a
   BotFather token — the app walks you through it.
3. **Tap the Telegram link and say hi.** That first message claims the agent as
   yours. Then just chat. (Only your first-ever agent needs this claim — later
   agents recognize your Telegram account from birth and answer immediately.)

To let others in, use **Invite…** on the agent card — send the link, or have
them scan the QR, or (if they're not on your network) send the agent's Telegram
link and approve them when they message it.

## The CLI

`hatchabot` speaks the same API as the web app, for scripting and remote
management. It's linked by `setup-host.sh`; configure it with
`~/.config/hatchabot/env` (`HATCHABOT_URL`, `HATCHABOT_PASSWORD`) or flags.
Every value in that file also works as a plain environment variable —
including `HATCHABOT_TOKEN` and `HATCHABOT_REFRESH_TOKEN`, for scripts that
shouldn't touch your config file. Env vars beat the file; flags beat both.

With per-user accounts, mint a token in the app (**⚙ Settings → Security →
New token**) and run `hatchabot login` — that works with any sign-in method,
including Google, which has no password for a CLI to use.

```sh
hatchabot list                          # state, model, last activity
hatchabot create "Kitchen Helper"       # incl. the BotFather step if needed
hatchabot logs "Kitchen Helper" -n 100
hatchabot snapshot "Kitchen Helper" --label "before the big edit"
hatchabot revert "Kitchen Helper" <snapshot-id>

# rehost an agent to another Hatchabot server, in one step
hatchabot servers add Desktop http://desktop:8080 <token-from-that-server>
hatchabot rehost "Kitchen Helper" Desktop

# or move it by file
hatchabot download "Kitchen Helper" -o kitchen.hatchabot
hatchabot --url http://desktop:8080 restore kitchen.hatchabot
```

`hatchabot help` lists every command. See
[docs/moving-agents.md](docs/moving-agents.md) for the migration rules.

## Configuration

All via `.env` in the repo root (generated by `setup-host.sh`, never committed):

| Variable | Purpose |
|---|---|
| `HATCHABOT_SECRET_KEY` | **Required.** Encrypts stored credentials. Losing it means re-entering every token. |
| `HATCHABOT_PASSWORD` | App password (password auth mode). |
| `PORT` | HTTP port, default `8080`. |
| `HATCHABOT_PUBLIC_URL` | Canonical URL used in invite links, e.g. a Tailscale hostname. |
| `HATCHABOT_AUTH` | `password` (default), `accounts` or `identity` — see below. |
| `HATCHABOT_DB` | SQLite path, default `data/hatchabot.sqlite`. |
| `HATCHABOT_IMAGE` | Runtime image tag, default `hatchabot-runtime:latest`. |
| `HATCHABOT_PREFIX` | Docker name prefix. Change it to run **two installations on one host**. |
| `HATCHABOT_GATEWAY_PORT_BASE` | First debug-UI port, default `19100`. Also for multi-install. |
| `HATCHABOT_BACKUP_DIR` | Nightly backups, default `~/hatchabot-backups`. |
| `HATCHABOT_BACKUP_KEEP_DAYS` | Backup retention, default `14`. |
| `HATCHABOT_AGENT_MEMORY` | Per-agent container memory cap, default `2g`. |
| `HATCHABOT_REBUILD_CONCURRENCY` | How many rebuilds run at once, default `6`. A rebuild takes about a minute, so this sets how long "Rebuild all" takes. |
| `HATCHABOT_CHECKPOINT_CONCURRENCY` | How many of those may summarise the agent's conversation first, default `2` — each is an AI call on the agent's own source. |
| `HATCHABOT_AGENT_PIDS` | Per-agent process limit, default `512`. |
| `HATCHABOT_OPS_PORT` | Port of the small server the management agent talks to (its tools and its filtered route to its AI provider), default `8091`. It listens only on that agent's isolated Docker network. |
| `HATCHABOT_OPS_DRIFT_MS` | How often the management agent's tool lockdown is checked, default 10 minutes. |
| `HATCHABOT_AGENT_NETWORK` | Docker network for agent containers, default `hatchabot-agents` (created on first use with inter-container traffic off, so agents can't reach each other's gateways). `bridge` keeps Docker's default network. Applies when an agent is created or rebuilt. |
| `HATCHABOT_DOCKER_TIMEOUT_MS` | Docker command timeout, default `60000`. |
| `HATCHABOT_RECONCILE_MS` | How often runtime state is re-checked, default `120000`. |
| `HATCHABOT_LOCAL_ACCOUNTS` | `1` runs local username/password accounts alongside Google sign-in (identity mode only). |
| `HATCHABOT_USAGE_SAMPLE_MS` | How often AI-source usage is measured, default `600000`. |
| `HATCHABOT_USAGE_CONCURRENCY` | Agents sampled at once, default `6`. |
| `HATCHABOT_USAGE_PASS_MS` | Budget for one whole sampling pass, default `300000`. |
| `HATCHABOT_A2A_TIMEOUT_MS` | How long a peer has to answer a consult, default `120000`. Raise it for tool-heavy work. |
| `HATCHABOT_BIND` | Listen address. Defaults to `0.0.0.0` whenever authentication is on, `127.0.0.1` when it is off (password mode with no password). |
| `HATCHABOT_TLS_CERT` / `HATCHABOT_TLS_KEY` | Paths to a PEM cert and private key. Set **both** to serve HTTPS directly (no reverse proxy); setting only one fails loudly. |
| `HATCHABOT_MAX_AGENTS_PER_MEMBER` | Optional lower cap for accounts that are not the host owner. |
| `HATCHABOT_MAX_AGENTS_TOTAL` | Optional ceiling on live agents across every account — bounds what any number of sign-ups can do to the box. |
| `HATCHABOT_MAX_AGENTS_PER_ACCOUNT` | Optional per-account cap on how many agents one account may create. Unset (or `0`) means no limit. |

**Who can sign in.** Three modes:

- `accounts` (**the installer's default**) — several people, each with **their own username and password**,
  kept in this installation's database. No cloud project, nothing to register.
  You invite someone with a one-time link and they choose their own password;
  each account owns its own agents, and sharing an AI source is what lets them
  spend your plan. Forgotten passwords are reset by a link, never a typed-in
  password (see `docs/identity.md`).
- `password` — one shared password, one implicit user. Still offered by the
  installer for a machine where everything belongs to you; switch out of it any
  time from ⚙ Settings → You → **Turn on family accounts**.
- `identity` — Google sign-in via GCP Identity Platform, needing
  `HATCHABOT_GCP_PROJECT`, `HATCHABOT_IDENTITY_API_KEY` and
  `HATCHABOT_GOOGLE_CLIENT_ID`. Add `HATCHABOT_LOCAL_ACCOUNTS=1` to run local
  accounts **alongside** Google, so the owner can keep a cloud project and
  nobody else needs one.

Moving forward (password → accounts or identity) is supported and adopts what
the install already owned; going back strands every per-account row. Setup and
rationale in [docs/identity.md](docs/identity.md).

**Off-network access.** Agents reach Telegram outbound from wherever they run,
so chatting works anywhere with no port forwarding. Only Hatchabot's own web
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
*not* `localhost`. Hatchabot
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
  mgmt/         the tool broker every management surface shares (web chat, the
                Hatchabot agent, and the legacy Telegram bot in bot.ts/index.ts)
  cli.ts        The hatchabot command
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
  releases; Hatchabot emits a handful of `openclaw config set` commands for
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

Logs: `journalctl --user -u hatchabot -f` (Linux) or `tail -f data/server.log`
(macOS).

**Never `cp` a running database.** Hatchabot uses SQLite in WAL mode, so an
un-checkpointed `data/hatchabot.sqlite` copies as an *empty* file. Use
`./scripts/backup-volumes.sh` (which uses SQLite's online backup API) or stop
the service first — shutdown checkpoints the WAL.

**What a backup contains.** The nightly run (a systemd user timer on Linux, a
launchd daily job on macOS — both installed by `setup-host.sh`) writes a dated
directory under `HATCHABOT_BACKUP_DIR` holding the control-plane database
(agent registry, memberships, encrypted credentials, memory snapshots), a copy
of `HATCHABOT_SECRET_KEY` — without which those credentials can't be decrypted
— and one tarball per agent volume (the agent's memory and OpenClaw state).
Restoring the database alone brings back everything Hatchabot knows; restoring
a volume brings back what an agent knows. Backups are as sensitive as the
system itself and live in a `0700` directory.

**Restoring from backup.** Stop the service first (`./scripts/restart.sh`
knows how to start it again afterwards; agent containers should be stopped
too). Then, from the dated backup directory you want:

1. Copy `hatchabot.sqlite` over `data/hatchabot.sqlite` (or wherever
   `HATCHABOT_DB` points).
2. Check that `.env` still has the `HATCHABOT_SECRET_KEY` line saved in the
   backup's `secret-key.env` — put it back if not. Without that exact key,
   every stored bot token and API key in the database is unrecoverable, and
   changing it also invalidates existing sessions (everyone signs in again).
3. Restore each agent volume you need, with that agent stopped. Run as root
   inside the container, then hand the files to the runtime user — a fresh
   volume (the new-machine case) is root-owned, so extracting as the image's
   own user fails on the first directory:

   ```sh
   docker run --rm --user root -v <volume>:/data -v <backup-dir>:/in:ro \
     hatchabot-runtime:latest \
     bash -c 'cd /data && tar xzf /in/<volume>.tgz --no-same-owner && chown -R 1000:1000 /data'
   ```

   Prove the whole procedure any time with `./scripts/restore-drill.sh` — it
   verifies the newest backup end to end (database integrity, the saved key
   decrypting a real secret, a volume restoring into a throwaway) without
   touching the live system.

4. Restart the service. If an agent comes up confused — wrong model, stale
   config — use **Rebuild**: the container is disposable, the volume you just
   restored is not.

## Status and limitations

Working and used daily by its author, but young — expect rough edges.

- **SQLite, single node.** Fine for a household; Postgres is the intended path
  for anything larger.
- **Telegram only.** The channel abstraction exists for others; nothing else is
  implemented.
- **Cloud hosting isn't built.** Hatchabot runs on machines you own.
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

### Additional environment variables (operator reference)

| Variable | Where | Purpose |
|---|---|---|
| `HATCHABOT_ALLOW_OWNER_HEADER` | server | **Test-only auth shim**: honor `x-hatchabot-owner`. Never set in production. |
| `HATCHABOT_CLAUDE_BIN` | server | Path to the `claude` CLI for the mgmt assistant (default `~/.local/bin/claude`). |
| `HATCHABOT_CLI_TIMEOUT_MS` | server | Mgmt CLI completion timeout (default 180000). |
| `HATCHABOT_READY_TIMEOUT_MS` / `HATCHABOT_READY_POLL_MS` | server | Agent health-wait tuning at provision. |
| `HATCHABOT_NAME_REPAIR_MS` / `HATCHABOT_IDLE_RENAME_MS` | server | Bot display-name repair/rename sweep cadence. |
| `HATCHABOT_SSH_DIR` | server | Override the runner-setup SSH dir. |
| `OPENCLAW_STATE_DB` | server | Override the adopted-OpenClaw state DB path (cron import). |
| `HATCHABOT_OPENCLAW_GATEWAY_UNIT` | server | systemd unit name quiesced during adopt. |
| `HATCHABOT_MGMT_OWNER` / `HATCHABOT_MGMT_PAIRING_POLL_MS` | mgmt bot | Audit owner label; approval-push poll interval. |
