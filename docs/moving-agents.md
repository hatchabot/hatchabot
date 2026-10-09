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
hatchabot adopt ~/.openclaw/workspace-garden-advisor "Garden Advisor"
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
hatchabot folders "Garden Advisor" add ~/condo-documents
```

### Without Telegram

An agent doesn't need a Telegram bot: its web console is a full chat.

```sh
hatchabot adopt ~/.openclaw/workspace-garden-advisor "Garden Advisor" --no-telegram
```

brings it in web-only. You talk to it from its icon in the web app, it costs
no bot slot, and a bot can be attached later. In the web adopt flow this is
**"No Telegram for now"**. It is ticked by default when the workspace has no
bot of its own, and an agent without a bot can be ticked in the list of
agents found on the machine.

### Reuse the bot it already has

Telegram caps one account at about **20 bots**, which is the real limit on how
many agents you can run — not CPU or memory. A workspace you are adopting
almost always already owns a bot, so:

```sh
hatchabot adopt ~/.openclaw/workspace-event-planner "Event Planner" --reuse-bot
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

Then use **Move to another Hatchabot** in the agent's Advanced tab, or:

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

The web app can do the same: **Download copy** in the agent's Advanced tab, then
**New** → *open a .hatchabot file* — it takes any `.hatchabot` file, restoring a full
backup as the same agent or standing a shared template up as a fresh one.

## Moves run in the background — where to watch one

Since v2.156.0 a move to another machine, a move to another Hatchabot, importing
a full copy, and a restore from a backup or a snapshot run **on the server, in
the background**. Hatchabot checks what it can first — the other machine is not
this one, the agent can move, the backup holds it, the other Hatchabot says yes
— and a refusal is said at once, as before. Once it has begun, the page, the
command line and the Hatchabot agent are told so straight away, and you can
close the page or the terminal: it goes on.

Where to watch it:

- **The agent's tile and its page.** The ring and the **Working on** line read
  the operation: *Moving to Laptop runner — step 4 of 10, made on the other
  machine · 2 min*. The page reads it every 2 seconds while it runs, and a
  message says how it ended (✅ moved, ⚠ failed or undone, ⏸ waiting for your
  choice).
- **Activity**, at the foot of the home screen: one line per operation —
  *Moved to Laptop runner · 3 min*, red if it failed or was undone, amber while
  it waits for you. Open the line (it is a button) to see its steps. Each step
  is also in the agent's **Setup log**.
- **The command line.** `hatchabot move`, `rehost`, `restore <file>`, `import`
  (a full copy), `revert` and `backups restore` print a line per step until it
  ends, and exit 1 if it failed, was undone or waits for a choice. `--no-wait`
  returns at once; `hatchabot ops [agent]` lists operations (kind, status,
  step n/m, outcome, age) and `hatchabot ops recover <op-id> <action>` makes a
  held one's choice.

```sh
hatchabot move "Kitchen Helper" "Laptop runner"     # this machine ⇄ a runner
hatchabot backups restore "Kitchen Helper" 2026-10-08 --yes
hatchabot ops                                       # what is under way, and the last day's
```

Older scripts that expect the old answer can add `?wait=1` to the request: the
server then answers when it is over, in the old shape. The other Hatchabot's
side of a move between servers (`POST /v1/agents/restore`) still answers when
the agent is running there — the moving server reads the agent from that
answer — and runs in the background only when asked with `?async=1` (the
command line's `restore` does).

## Interrupted operations

A move takes minutes, and Hatchabot can restart in the middle of one: an
automatic upgrade, a crash, the machine rebooting. Since v2.154.0 every move
and every import writes down each step as it is done, and since v2.155.0 so do
restores, archives, rebuilds, app installs and a runner's image copy. After a
restart Hatchabot knows exactly where each one stopped and puts it right on
purpose:

| What was interrupted | What Hatchabot does after the restart |
|---|---|
| A move to another machine, before the agent was recorded there | Undoes it: removes the half-made copy there (if that machine answers), and starts the agent again where it was if it was running |
| A move to another machine, after it was recorded there | Finishes it: starts it there, settles its skills and memory index, then removes the old copy |
| An import (a file, or a move arriving from another Hatchabot) | Undoes it completely — a half-imported agent never starts. Import the file again |
| A move to another Hatchabot, after the agent was packed up | Asks the other server whether it arrived: yes — this copy stays stopped, marked as moved; no — it is started here again |
| A restore from a backup, before the copy of how it was had been saved | Undoes it: nothing was changed, and the agent is started again if it was running |
| A restore from a backup, after that copy was saved (to `restore-safety/` beside the backups) | Its memory may be half-restored, so it stays **stopped** and waits for you: **Finish the restore** or **Put back the copy from before**. (If only the restart itself was left, it finishes by itself.) |
| A restore of a snapshot, part-way through its files | Waits for you: **Finish** or **Revert to the copy taken before** (the snapshot taken just before the restore). If none of its files had changed yet, or all had, it settles by itself |
| An archive, before its bot was given back | Undoes it: started again if it was running |
| An archive, after its bot was given back | Finishes it: archived, its container left stopped. Going back would need a new bot |
| A rebuild waiting its turn | Puts it back in the queue (unless the agent moved, stopped or was archived meanwhile) |
| A rebuild or a setup under way | As before: running again → marked running; stopped → **"The rebuild was interrupted — tap Retry"** (or "Setup was interrupted"). The outcome is now on its record |
| An app install, update or roll back, before the switch | Nothing live changed: undone. Install or update again |
| An app install, update or roll back, during or after the switch | Compares the release the agent runs with Hatchabot's record: the same → done; different → waits for you: **Use the new release** or **Go back to the previous one** |
| Copying the runtime image to a runner | Marked failed: **Install image** again (Settings → Hosts says "interrupted", not idle) |

When Hatchabot cannot tell which way is right — the other machine or the other
server is not answering, or only you know which outcome you wanted — it does
not guess. The agent waits (stopped, except during a snapshot restore, where it
keeps running), shows under **Alerts**, and its page offers the choices, for example **Try again when
Laptop is back** or **Put it back on This machine**. A move to another Hatchabot
is asked about again every 10 minutes by itself. Until one of these is settled,
Start, Rebuild, Archive, Move and Delete say why they must wait, so two copies
can never answer the same bot.

A held operation comes **first under Alerts**, in its own *Waiting for your
choice* section, which cannot be cleared away. The Activity list shows each
operation as one line that opens to its steps, and the agent's Setup log shows
every step. A machine's own operations — copying the image to a runner, **Back
up now** — show in the Activity list too, to that machine's owner. The command
line and the Hatchabot agent can read them: `hatchabot ops`, `GET
/v1/operations?agentId=…`, and the agent's `list_operations` and
`recover_operation` tools.

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
**template** instead (**Share** in the agent's Sharing tab, under Copy or share;
**New** → *open a .hatchabot file* takes it, or `hatchabot share` / `import`).

A template leaves out the agent's **identity** — but it is not safe to email
unread. Agents write names, addresses and phone numbers into their own
`AGENTS.md`, and those travel. Share counts the email addresses, phone numbers
and key-shaped strings the copy mentions and shows where, before the file is
saved or sent (`hatchabot share` prints the same list). Read it before you send it.

| Carried | Left out |
|---|---|
| the trained **`SOUL.md` + `AGENTS.md`** (minus the sections Hatchabot writes for this machine) | the **bot token** |
| its enabled **scheduled tasks** (name, schedule, message) | all **members** and their Telegram IDs |
| the agent's **`MEMORY.md`** (web: asked when you Share; CLI: only with `--include-memory`) | conversation history, its daily notes (`memory/`) and `USER.md` |
| the AI **vendor** preference | — |
| a checklist of **data sources & env-var names** it expects | — |

**Import stands up a fresh agent.** The importer owns it, gives it its **own**
bot (a pool bot or a pasted BotFather token — the normal create flow), binds
their **own** AI source, and invites their **own** people. The trained files
seed the new agent at first provision. Import then prints what the agent still
needs — any data sources or env vars the template declared — for the recipient
to wire up in **⚙ Settings**.

*Note on memory:* the web app asks when you Share — OK also includes
`MEMORY.md` (its summary notes), Cancel leaves it out; the CLI leaves it out unless you
pass `--include-memory`. If the memory holds personal facts (or, on a
shared-memory agent, `source:<telegram_id>` tags), share without it, or curate
`MEMORY.md` first.

Download/Restore = "the same agent, elsewhere." Share/Import = "a trained copy, for
someone else."
