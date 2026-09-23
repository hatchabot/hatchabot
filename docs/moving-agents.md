# Moving an agent between machines

An agent is portable as a single `.hatchabot` file: its memory and workspace
files, its members (including revoked ones), its Telegram bot identity, and
hints about the AI it ran on. Import re-provisions it against the *target*
machine's own AI source and host — so an agent can move from a subscription
laptop to an API-key server and keep its mind.

## Adopting an agent you built by hand

If you already run OpenClaw agents outside Hatchabot, you can bring one in
without retyping anything. In the web app, open **New agent → "Already built one
in OpenClaw? Bring it in →"**, point it at the workspace folder, and it shows a
preview (what will copy, what's skipped, the bot it already owns) before you
confirm. Or from the command line:

```sh
hatchabot adopt ~/.openclaw/workspace-tech-advisor "Tech Advisor"
```

Either way it shows what it found, creates a managed agent (asking for a
BotFather token if the pool is empty), and copies the **entire** workspace — not
just SOUL/AGENTS/MEMORY, but IDENTITY.md, USER.md, TOOLS.md and whatever domain
files the agent has accumulated, because that is usually where its real
knowledge lives.

Excluded on purpose:

- session databases (`openclaw-agent.sqlite*`) and credential files
  (`auth-profiles.json`, `auth-state.json`) — the new agent gets its own;
- build artifacts (`node_modules`, `venv`, `__pycache__`, and friends) —
  they are compiled for the host they were built on, with absolute paths
  baked in, so copying them into a container gives you broken binaries
  rather than a working agent. Adopt names what it skipped.

The size guard exists because of that last point: one real workspace here
was over a gigabyte across 20,000 files, nearly all of it a Python `venv`
sitting next to 800 KB of actual notes. If what remains after skipping
artifacts is still over the limit (750 MB or 20,000 files), adopt refuses
and points you at folder sharing — bulk data
belongs in a folder the agent *reads*, not in a copy the agent *owns*:

```sh
hatchabot folders "Tech Advisor" add ~/condo-documents
```

### Reuse the bot it already has

Telegram caps one account at about **20 bots**, which is the real limit on how
many agents you can run — not CPU or memory. A workspace you are adopting
almost always already owns a bot, so:

```sh
hatchabot adopt ~/.openclaw/workspace-conf-advisor "Conference Advisor" --reuse-bot
```

takes that bot over. It costs no new slot, and everyone who already messages
`@CnfAdvBot` keeps the same conversation instead of being handed a stranger.
The people on its allowlist come across as members too, so nobody — including
you — has to pair with an agent they were already talking to. (In the web
adopt flow this is the **"Take over its bot @…"** checkbox, on by default.)

Because a Telegram bot may only be polled by one process, adopt refuses while
the old instance still has that bot switched on, and tells you how to hand it
over:

```sh
openclaw config set channels.telegram.accounts.CnfAdvBot.enabled false
systemctl --user restart openclaw-gateway
```

It checks the old instance's own config for this, not Telegram: a poller
resting between long-polls is indistinguishable from no poller at all, so
asking Telegram can confirm a conflict but can never rule one out.

**The original is only ever read.** It keeps working until you retire it, so
you can compare the two. One rule: do not point both at the same Telegram
bot, or they will fight over every message — Hatchabot refuses to wire a bot
that already belongs to another agent, at the API and again at provisioning
time, because two pollers on one token is unrecoverable confusion rather
than a clean error.

If you recycle a bot from a retired agent, its Telegram display name stays
whatever BotFather knows. Send `/setname` to @BotFather to rename it, or the
new agent shows up under the old one's name.

## What happens to shared folders when an agent moves

Folder shares are *host paths*, and a path on one machine rarely exists on
another. They are therefore carried in the archive as a **declaration**, never
auto-applied: preflight refuses the move if the destination lacks those
folders, telling you which. Create them there (or re-share different ones
after the move) and it proceeds. The agent never silently arrives blind to
the data it was built around, and never silently reads a same-named folder
that happens to hold something else.

## One-step move between servers

If both machines run Hatchabot, register the destination once and move agents
with a single action — no files to shuttle.

On the **destination**: ⚙ Settings → Security → **New token**, and copy it.

On the **source**: ⚙ Settings → Hosts → Other Hatchabot servers → add its name, URL and that token.
Hatchabot checks the token works before saving it.

Then use **Rehost** on the agent card, or:

```sh
hatchabot servers                      # list registered servers
hatchabot rehost "Kitchen Helper" Desktop
```

What happens, in order:

1. **Preflight** — the destination is asked whether it *would* accept: is the
   agent id free, is that bot already wired to something there, does it have a
   host and an AI source. Nothing has changed yet, so a refusal costs nothing.
2. **Package & stop** — the agent is snapshotted and **stopped** here. From this
   moment nothing is polling its bot.
3. **Provision** — the destination brings it up and starts it. It is now the only
   copy running.
4. **Verify** — if it did not come up there, the move is undone.

**If anything fails, your agent is put back exactly as it was.** The
destination rolls itself back completely, and the source is restarted. The one
thing that is *not* automatic is deleting the source: it is left **stopped**,
because an automatic delete would make a mistaken move unrecoverable. Delete it
yourself once you have confirmed the agent works on the other machine — and
until then, never start it, or two runtimes will fight over one bot token.

## Moving by file instead

On the target machine (once):

```sh
git clone https://github.com/hatchabot/hatchabot.git hatchabot
cd hatchabot && ./scripts/setup-host.sh
# then open http://localhost:8080 and connect an AI source (⚙ Settings → AI sources)
```

Then, from anywhere:

```sh
# on the source (or remotely, with --url):
hatchabot download kitchen-helper -o kitchen.hatchabot

# copy the file over (scp, tailscale file cp, USB stick — it's just a file)

# on the target:
hatchabot restore kitchen.hatchabot
```

The web app can do the same: **Download** on the agent card, then **Import** in
the header — the one Import button takes any `.hatchabot` file, restoring a full
backup as the same agent or standing a shared template up as a fresh one.

## Rules of the road

- **The file is a credential.** It contains the agent's Telegram bot token
  AND (since v0.94.0) every env var's name **and value** — the whole point is
  that the agent arrives working, so the archive holds its secrets. Treat it
  like a password; delete it after a successful import. Import re-validates
  every env name against the reserved-name policy, so a tampered archive
  can't smuggle a proxy/credential/loader variable.
- **One poller per bot.** Download leaves the source agent STOPPED. Keep it
  that way (or delete it) once the import is live — two copies polling the
  same bot flip-flop messages between them. Telegram needs no changes:
  bots connect outbound from wherever they run.
- **AI doesn't travel.** The import binds the agent to an AI profile on the
  target (vendor-matched by default, `--profile <id>` to choose). Model
  config is re-applied from the target's profile; memory is untouched.
- **The owner seat transfers.** Whoever imports owns the copy. Other
  members ride along with their Telegram bindings intact.
- Importing where a same-slug agent already *lives* is refused; a previously
  deleted agent's tombstone doesn't block a re-import.

## Share a trained copy — Share / Import (templates)

Download/Restore and Rehost move **the same agent** — same bot, same people, same
memory. To hand someone a copy of an agent you *built and trained*, use a
**template** instead (**Share** on the agent card's ⋯ menu; the same **Import**
button in the header takes it, or `hatchabot share` / `import`).

A template is deliberately **stripped of identity**, so it's safe to email:

| Carried | Left out |
|---|---|
| the trained **`SOUL.md` + `AGENTS.md`** | the **bot token** |
| the agent's **`MEMORY.md`** (web: asked when you Share; CLI: only with `--include-memory`) | all **members** and their Telegram IDs |
| the AI **vendor** preference | conversation history |
| a checklist of **data sources & env-var names** it expects | — |

**Import stands up a fresh agent.** The importer owns it, gives it its **own**
bot (a pool bot or a pasted BotFather token — the normal create flow), binds
their **own** AI source, and invites their **own** people. The trained files
seed the new agent at first provision. Import then prints what the agent still
needs — any data sources or env vars the template declared — for the recipient
to wire up in **⚙ Settings**.

*Note on memory:* the web app asks when you Share — OK for a faithful copy,
Cancel for persona & instructions only; the CLI leaves memory out unless you
pass `--include-memory`. If the memory holds personal facts (or, on a
shared-memory agent, `source:<telegram_id>` tags), share without it, or curate
`MEMORY.md` first.

Download/Restore = "the same agent, elsewhere." Share/Import = "a trained copy, for
someone else."
