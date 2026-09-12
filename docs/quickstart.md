# AgentClaw — Quick start

**Goal: your first agent answering you on Telegram in about 15 minutes.**

AgentClaw runs AI agents on a computer you own and puts each one behind a
Telegram bot, so you (and anyone you invite) chat with it like a contact. This
guide is the shortest path from nothing to a working agent. The full README
covers everything else.

## 0. What you need

| | Why |
|---|---|
| **A computer that stays on** — Linux or macOS, with **Docker** and **Node.js 22+** | Agents run here, one container each. A Mac mini, a home server, a spare laptop that never sleeps. |
| **A Telegram account** (the app on your phone) | Telegram is the front door. Agents are Telegram bots you create. |
| **An AI to think with** — recommended: a **Claude subscription** (Pro or Max) | One subscription powers every agent. Alternatives: an Anthropic or Google API key, or a local model server (Ollama) that needs no account at all. |

> Claude **Max** is the comfortable choice for a household of agents; **Pro**
> works for one or two light ones. You can also mix: a cheap or local model for
> simple agents, Claude for the demanding ones — chosen per agent.

## 1. Install Telegram and make a bot (2 min)

1. Install **Telegram** on your phone and sign in.
2. Open **@BotFather** (search for it), send `/newbot`.
3. Give it a display name (e.g. *Kitchen Helper*) and a username ending in `bot` (e.g. `kk_kitchen_helper_bot`).
4. BotFather replies with a **token** like `123456789:AAH...`. Keep it — AgentClaw will ask for it. Treat it like a password.

You can make more later (one per agent, ~60 seconds each), or pre-stock a pool so new agents are instant.

## 2. Get Claude ready (3 min)

1. Subscribe at **claude.ai** (Pro or Max).
2. On the computer that will run AgentClaw, install the Claude CLI and log in:
   ```sh
   npm install -g @anthropic-ai/claude-code
   claude            # follow the login prompt once, then exit
   ```
3. Generate a **setup token** — a portable credential AgentClaw injects into agents:
   ```sh
   claude setup-token
   ```
   Copy the token it prints. (If you'd rather use an API key or a local model, skip this — step 4 offers those too.)

## 3. Install AgentClaw (5 min, mostly waiting)

```sh
git clone https://github.com/cksci/agentclaw-ai.git agentclaw
cd agentclaw
./scripts/setup-host.sh
```

The script checks Docker and Node, installs dependencies, asks you to choose an
**app password**, builds the agent runtime image, installs a background service
so AgentClaw starts with the machine, and links the `agentclaw` command. It is
safe to re-run.

Open **http://localhost:8080** and unlock with your password. On a phone on the
same network use the computer's address instead (e.g. `http://192.168.1.20:8080`) —
and "Add to Home Screen" to get an app icon.

## 4. Connect the AI (1 min)

The **Welcome** card asks for exactly one thing. Paste the `claude setup-token`
from step 2, pick a model (Opus for best, Sonnet for faster), and tap
**Use my Claude subscription**. That's your first *AI source*. (⚙ Settings →
AI sources is where you add an API key or a local Ollama server later.)

## 5. Create the agent (1 min)

1. Tap **+**. Give it a **name** and a one-paragraph **description** of who it is and what it's for — this becomes its personality file, which you can edit any time.
2. Paste the **BotFather token** from step 1 when asked (or, if you've stocked the bot pool, it just takes one).
3. Tap **Create**. AgentClaw builds its container, wires the bot, and shows a Telegram link on the card.

## 6. Say hi (30 s)

Tap the Telegram link (or search your bot's username in Telegram) and send any
message. That **first message claims the agent as yours** — only your very first
agent needs this; every later agent recognises you from birth. Then just chat.

**That's it.** Everything the agent learns lives in its own memory files on your
machine, survives restarts and rebuilds, and is yours to read and edit.

## Where to go next (all optional)

- **Tell it who you are once** — ⚙ Settings → **👤 You**. Injected into every agent you make.
- **Let family in** — **Invite…** on the card: a link or QR for chat-only access, or a full invite so they can also log into AgentClaw. Or make an agent a **group room**.
- **Give it your Google account** — ⚙ Settings → Connections (Gmail, Calendar, Drive, Sheets). Per agent, with a "no send" option.
- **Give it data** — the agent's **Data** tab: a read-only folder, a writable one, or a git repo it commits to.
- **Schedule it** — the **Tasks** dialog: a morning briefing, an inbox poll, a weekly digest.
- **Let agents consult each other** — the agent's **Peers** tab.
- **Keep it cheap** — **Classes** (⚙ → AI sources) put simple agents on a cheaper model and demanding ones on the best, in one place.
- **Back up / move / share** — every card: Download (a single file), Rehost (to another AgentClaw), Share (as a template with no secrets).

## If something's off

- **Agent card says FAILED** → the reason is on the card; **Retry** usually fixes a first-boot hiccup.
- **"Couldn't reach the AI"** → check the AI source in ⚙ Settings; a setup token can expire — run `claude setup-token` again and paste the new one.
- **Local model agents can't connect** → the model server must listen on an address containers can reach (not `localhost`); the README's "Running on your own hardware" section has the exact settings.
- **Something looks stale** → the app is a PWA; pull to refresh or reopen it.
