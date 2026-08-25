# AgentClaw features — a tour

What exists today (v0.31.2), in one place. Each section says how to do the
thing; where a deeper doc exists, it's linked instead of duplicated.

## What AgentClaw is

AgentClaw turns a machine you own into a home for AI agents. Each agent is an
OpenClaw runtime in its own Docker container with its own durable volume
(memory, config, sessions), fronted by a Telegram bot — so agents are
ephemeral problem-solvers you create, use, and delete, while the bots that
front them are pooled and recycled. You manage the fleet from a web app
(installable as a phone PWA), the `agentclaw` CLI, or an optional Telegram
management bot.

## Creating & talking to agents

To create an agent, tap **+** in the web app: name it, optionally answer
"What is it for?" (that text becomes its persona), pick an AI source, and —
when more than one host exists — pick where it runs ("Runs on"). A "Keep
memory private" checkbox decides shared vs private memory at birth.

Every agent needs a Telegram bot. Telegram has no API to mint bots, so
AgentClaw **leases them from a pool** (`scripts/pool-add.ts` stocks it); if
the pool is empty you're walked through creating one at
[@BotFather](https://t.me/botfather) and pasting the token (~60 seconds).
Deleting an agent returns a pool bot for reuse.

Tap **Telegram App** on the card and say hi. Your first-ever message claims
the agent as yours; later agents recognize your Telegram account from birth
and answer immediately. Send `/new` in Telegram to start a fresh
conversation (file edits apply to new conversations).

Three files define an agent, all editable in the app: **SOUL.md** (who it
is — the persona), **AGENTS.md** (how it works), **MEMORY.md** (what it
knows).

## Training & memory

To edit an agent's mind, open **⚙ Settings** on its card. The dialog has six
tabs: **📖 Definition · Snapshots · AI · Data · Telegram · Environment**.

- **Definition** — rename the agent, edit SOUL.md / AGENTS.md / MEMORY.md,
  and toggle **shared memory**: On means MEMORY.md is a common log for every
  member (entries tagged with who said them, and anything written may surface
  to other members); Off means memory is private to you. You can only change
  this while you're the only member.
- **Snapshots** — point-in-time copies of the three definition files, taken
  automatically before file edits and rebuilds, or on demand (**Snapshot
  now**). Restore one to roll the agent's definition and memory back — so a
  bad edit is always undoable. (CLI: `agentclaw snapshot` / `revert`.)

**Rebuild** (on the card) replaces the container but keeps the volume —
containers are cattle, volumes are not. Only **Delete** purges, and it makes
you type the agent's name.

## Copying & moving

Five distinct verbs, for five intents:

- **⧉ Clone** (card) — duplicate the agent on this machine: a faithful copy,
  memory included, with its own bot and name. CLI: `agentclaw clone`.
- **📤 Share** (card) — export a **template** for someone else: the trained
  SOUL.md + AGENTS.md and memory (untick to send "persona & instructions
  only"), the AI vendor preference, and a checklist of data sources and
  env-var *names* — but **no bot token, members, or conversation history**.
  Safe to email. The recipient uses **Import** (header) to stand up a fresh
  agent with their own bot, AI source, and people.
- **Import** (header) — opens any `.agentclaw` file and auto-detects it: a
  full backup is restored as the *same* agent; a template becomes a *fresh*
  one.
- **Download copy** (card ⋯ menu) — a complete private copy to a file (bot
  token, members, memory) for your own keeping; restore it anywhere with
  `agentclaw restore`. Don't share it.
- **Move** (card, shown when more than one host exists) — relocate the agent
  to another **runner in this cluster**: it stops, its volume is copied to
  the target host, and it starts there. Same agent record, same bot, same
  members; any failure rolls it back where it was. While it moves the card
  shows a pulsing **WORKING…** chip.
- **Move to another cluster** (card ⋯ menu) — send the agent to a different
  AgentClaw server entirely (registered under ⚙ Settings → Cluster servers).
  It transfers with memory, members, and Telegram identity, and is managed
  from that server's dashboard afterwards. The local copy stays STOPPED —
  never start both, they'd fight over the same bot. CLI: `agentclaw rehost`.

Rules and formats: [moving-agents.md](moving-agents.md).

## Adopting existing OpenClaw agents

If you already run hand-built OpenClaw agents, bring them in from
**New agent → "Already built one in OpenClaw? Bring it in →"**. The dialog
**discovers** every OpenClaw agent installed for this server's user (from
`~/.openclaw/openclaw.json`), annotated with its bot and whether it's already
in AgentClaw. Tick any and **Bring in selected**. For each one, adopt:

- **Hands over the bot automatically** — disables it in the OpenClaw config
  (a `.agentclaw-bak` backup is written first), restarts the gateway once for
  the whole batch, verifies the bot went quiet, then takes it over. The
  approved members ride along, so nobody re-pairs.
- **Copies the whole workspace** and **rewrites absolute paths** in files and
  crons to their in-container locations, so prompts and schedules resolve.
- **Carries scheduled tasks (crons)** from OpenClaw's gateway DB — brought in
  **disabled**, so you review them in ⏰ Tasks before they fire.
- **Offers to share external data folders** the workspace references —
  read-only, mounted at their **original host paths** inside the container,
  so existing references keep working.

The originals are only read and keep working until you retire them. A manual
path is under "Or point at a workspace folder manually". CLI:
`agentclaw adopt <workspace-dir> <name> [--reuse-bot] [--bot-token <tok>]` —
`--reuse-bot` takes over the workspace's existing bot instead of spending a
new bot slot.

## Data & secrets

**⚙ Settings → Data** — what the agent can read beyond its own workspace:

- **Folders** — a host directory bind-mounted at `/data/<folder>`, read-only
  by default (kernel-enforced; credential and system paths are refused).
  Writable folders exist but are machine-owner-gated and warned: anyone who
  can message the agent can ask about — and for writable, change — those
  files.
- **Git repos** — first-class: AgentClaw generates a repo-scoped **deploy
  key** (copy it from the 🔑 Deploy key button, add it on GitHub), then
  clones the repo onto the agent's own volume. Read-only or read-write —
  writes are commits and pushes, never raw writes to your disk.

Details: [data-sources.md](data-sources.md). Changes apply on the next
**Rebuild**.

**⚙ Settings → Environment** — per-agent environment variables for the
agent's **own tools, not its AI**: when its scripts or scheduled tasks call
an outside service (a market-data API, a home-automation hub), the key they
read lands here. Most agents need none. Values are write-only — stored
encrypted, never shown again — and injected on the next Rebuild.
Provider/proxy/loader names are reserved so a variable can't shadow the
managed AI credential. Details: [agent-environment.md](agent-environment.md).

**⚙ Settings → Telegram** shows the agent's bot token (tap Show). The bot
*is* the agent's identity — reveal the token only to recycle the bot into a
future agent or move this one by hand.

## Members & invites

To let someone in, tap **Invite…** on the card:

- **Invite link** — works once, expires in 48 hours; they join as a member
  (they can chat, not change settings). If the agent's memory is shared, the
  join page tells them so before they accept.
- **Off your network?** Send the agent's Telegram link (or the QR code)
  instead. When they message it, a "wants to talk" card appears on the agent
  and **Let them in** makes them a member.

Members show on the card; remove one with its **×**. CLI: `agentclaw invite`,
`approve`, `members`, `kick`.

## Fleet operations

**📊 Health** (header) is the fleet dashboard: counts (running / stopped /
failed / working), a "needs attention" list (failed agents with their reason,
agents waiting for a bot, running agents idle over 14 days), and a per-agent
line with state, model, and last activity. The host owner also sees **backup
health** (latest set and its age) and **runtime** (image version, upgrade
available). **Run health checks** probes each running agent's in-container
gateway live. Per-agent, the card's ⋯ menu has **📊 Usage** (tokens by model,
honest billing context), **❤️ Health** (is it actually answering?), and
**Logs**.

**⚙ Settings → Runners** manages the machines this cluster runs agents on
("this machine" is the built-in runner). Adding one is a guided three-step
flow: enable SSH + Docker on the runner, paste one command there (it
authorizes this server's dedicated key and fixes PATH quirks), then enter
`ssh://user@host` — the SSH key, its config, and host-key acceptance are
handled automatically, and if the runtime image is missing an **Install
image** button copies it over. Details and troubleshooting:
[runner-setup.md](runner-setup.md). Day to day: **Check** a runner's
reachability, **Drain** it (stop every running agent, to take it out of
service), then Move the stragglers off and **Remove** it.

Two multi-machine shapes exist and compose: a **Cluster** is one control
plane placing agents across runner hosts (one dashboard, Move between
runners); a **Mesh** is independent AgentClaw servers peered as **Cluster
servers**, with "Move to another cluster" carrying agents between them. See
[topologies.md](topologies.md), and [deploy-gce.md](deploy-gce.md) for
running a node on a cloud VM.

## Backups & recovery

Three layers, smallest to largest:

- **Snapshots** — the three definition files, per agent, before every edit
  (⚙ Settings → Snapshots).
- **Backups** — nightly, server-side, machine-wide: every agent volume plus
  the control-plane database and secret key, written to dated sets on disk
  (`backup-volumes.sh`, installed as a timer by setup). **⚙ Settings →
  Backups** lists the sets, warns when one is missing its registry or
  decryption key, and offers **Back up now** and per-set delete. Each
  backed-up volume shows a **Restore** button that replaces that agent's
  **entire volume** from the chosen set — you type the agent's name to
  confirm, a safety copy guards against a broken archive. The API serves
  only metadata, never the backup files themselves.
- **Download copy** — a portable single-file copy you keep off the machine.

Full-machine restore steps and the restore drill are in the README's
Operations section.

## AI sources

**⚙ Settings → AI sources** holds the credentials agents run on. Kinds:

- **API key** — Anthropic or Google Gemini; stored encrypted, injected at
  boot, runs on any host including cloud.
- **Claude Pro/Max subscription**, two flavours: **machine login** (reuses
  this box's `~/.claude` in place — local/desktop hosts only) and
  **setup-token** (`claude setup-token`, stored and injected as an OAuth
  token — runs on runners too, and the only route on macOS).
- **Local model server** (Ollama) — no credential anywhere; nothing leaves
  the machine. Point it at the docker bridge address, not localhost.

Each agent picks its source in **⚙ Settings → AI**, and cloud agents can
additionally pin any **model** from that source's list (or follow its
default) — one Claude source can drive a cheap model for simple agents and a
top model for demanding ones. Applies on the next Rebuild.

A profile's **Shared** toggle lets every account on this server use it for
their agents. That is a credential hand-off, not a metered proxy — share only
with people you trust with the underlying key. Full detail:
[ai-profiles.md](ai-profiles.md).

## Bots census

Telegram caps an account at about 20 bots and offers no API to list them, so
`agentclaw bots [--check]` enumerates every bot this install (and each
registered peer server) uses: **in-use** (a running agent), **reclaimable**
(a stopped/failed agent, or an unleased pool bot), or **dead** (`--check`
asks Telegram). A `⇄ also` marker flags a bot appearing in two places — a
move or adopt leftover. Anything it can't see, check at @BotFather →
`/mybots`.

## CLI + management bot

The `agentclaw` CLI speaks the same API as the web app — create, list, logs,
snapshots, moves, adopt, backups, health, usage, and more. Run
`agentclaw help` for the full list; configure it via
`~/.config/agentclaw/env` or mint a token in **⚙ Settings → Access** and
`agentclaw login`.

An optional **Telegram management bot** controls the fleet from chat: list,
start/stop, rebuild, approve pairing requests, plus read-only `/health`,
`/usage`, and `/events` — every change confirmed with a tap. Set it up with
`agentclaw mgmt-bot setup` (needs its own BotFather token; discoverable in
⚙ Settings → Access). Design and limits:
[control-interfaces.md](control-interfaces.md) and
[management-broker.md](management-broker.md).

## Smoke test

`npm run smoke` runs a fully isolated end-to-end test: a throwaway control
plane on its own port and Docker namespace adopts an agent against real
Docker and a real Telegram bot, then tears everything down — it never touches
your real server or agents. Put a throwaway BotFather token in a git-ignored
`.env.smoke` at the repo root (`AGENTCLAW_SMOKE_BOT_TOKEN=…`); without one
the test skips cleanly, so it's safe in CI or cron.
