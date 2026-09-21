# Hatchabot features — a tour

What exists today, in one place. Each section says how to do the thing; where a
deeper doc exists, it's linked instead of duplicated. Updated 2026-09-20.

**Start here: you don't have to do any of it yourself.** Hatchabot ships with a
manager — *your Hatchabot agent* — that you talk to in plain words: "which
agents look unhealthy?", "make a travel agent for the Sicily trip", "put Taco
Agent back on the fleet image". It reads everything and changes nothing:
anything that would alter your fleet comes back as a card you confirm. Nobody
else's agent platform hands you an agent whose job is running the platform.
See [Your Hatchabot agent](#your-hatchabot-agent-the-manager).

## What Hatchabot is

Hatchabot turns a machine you own into a home for AI agents. Each agent is an
OpenClaw runtime in its own Docker container with its own durable volume
(memory, config, sessions), fronted by a Telegram, Slack or Discord bot — or
by nothing at all, in which case you talk to it in the app. Agents are
ephemeral problem-solvers you create, use, and delete, while the Telegram
bots that front them outlive any one agent and can be recycled into the next.

You run the fleet three ways, and the first is the one that makes Hatchabot
different: **ask your Hatchabot agent**, a manager that lives in the fleet it
manages; the **web app** (installable as a phone PWA); or the **`hatchabot`
CLI**.

## The home screen

Since 1.15.0 the app opens on the icon home screen. The older card view is
still there: open the account menu (your initial, top right) and choose
**Classic look**, or add `?ui=classic` to the address. The choice is
remembered in that browser; **✨ New look** in the classic header, or
`?ui=v2`, switches back. Both views drive the same actions.

The header holds:
- **New agent**, whose panel also offers *start from a template* and *open a
  .hatchabot file*.
- **Fleet**: one panel with tabs for Health, Usage, AI in use, Activity, and
  Tools (bulk actions, rebuild all, sort A→Z).
- **Settings**: this machine's settings, opened directly.
- An inbox button, which appears only when someone has sent you an agent.
- The account menu: who you're signed in as, light or dark appearance,
  install as an app, help, the classic look, the version, and sign out.

- **The manager's dashboard.** Beside the Hatchabot agent, the fleet in tiles
  drawn like the agent icons: **awake** (11/13), **asks / 5h** (with a
  sparkline of the last hours), **tokens / 24h**, **last backup** (amber past
  36h), **spare bots** (wearing the same Telegram badge the agent icons do, so it
  reads as spare *Telegram* bots), and — only when they are not zero — **to read**, **to
  confirm**, **knocking** and **to rebuild**, which take priority when the row
  runs out of room. Each tile opens the screen that acts on it. On a phone the
  four most urgent stay.
- **The setup guide doesn't disappear.** Until the first agent exists it shows
  itself — connect the AI, make a Telegram bot, create the agent. After that it
  keeps going with the three steps that decide whether the house is actually
  set up: give the **Hatchabot agent its own Telegram bot**, put the app on an
  **HTTPS address** your phone can reach, and **check a backup has run**. Every
  step is ticked from live state, never from "you have seen this", so it is
  still honest a month later. **Setup** sits in the top bar next to Settings,
  with a badge counting what is left; there is also a **set up** tile on the
  dashboard (`3/6`), an entry in the account menu, and a button in the classic
  look's toolbar.
- **Waiting for you** collects what needs you: changes your manager prepared
  (Confirm / Cancel), the ones that were confirmed and then *failed*, with the
  reason, and **people knocking** — a join request with **Let them in**,
  **That's me** and **Not now**, which is where someone is admitted now that
  the Telegram management bot is retired.
- **Each group can sort itself.** **A→Z** and **⏳** (newest first) on a group
  header are sticky: the section keeps that order as agents are added or moved
  in, instead of the newcomer landing on top and the order you asked for
  decaying. The button you pressed stays lit; press it again to stop. Dragging
  an agent by hand also stops it — placing something deliberately is a
  statement that you want it there.
- **Agents are icons** in their groups. Drag one to reorder it, onto another
  group to move it, onto **Archived** to archive it, or onto the strip that
  appears at the bottom to start a new group. On a phone, press and hold,
  then drag; an ordinary swipe still scrolls.
- **A red dot at the top left** means the agent has said something in its
  console since you last had that console open — a reply that finished after
  you closed it, or a scheduled run on an agent with no messaging app.
  Opening the console clears it. Messages that went to Telegram, Slack or
  Discord are not flagged; those apps show their own unread marks.
- **A small mark on the icon** shows which messaging apps reach the agent: a
  blue paper plane for Telegram, a purple hash for Slack, a blurple pad for
  Discord. An agent on two apps wears both marks, overlapped, rather than one
  mark and a **+1** that never said which app it stood for.
- **An idle badge** on a quiet agent says how long it has been quiet — `2h`,
  `1d`, `1w` — so a fleet of icons tells you at a glance which ones have
  stopped being used.
- **Status lives on the icon**, in the settings sheet too: its bar carries the
  agent's icon, its name and one coloured pill — *Ready*, *Worth a look*,
  *Waiting for a bot* — with Start, Retry or Restore right there, instead of
  repeating all of it as a row inside Overview. On the home screen: a dashed
  spinning ring while it rebuilds, red
  with **!** when it failed or its AI source is rate-limited, a dotted blue
  ring when it is waiting on you (a bot token, someone asking to join),
  greyed out when stopped. Hover for the reason.
- **Click an icon to talk to it.** It opens OpenClaw's console in the page
  (over HTTPS, see `docs/tailscale.md`). The **⚙ Settings** button in its bar
  opens the agent's settings. An agent that needs you opens straight to
  settings instead.
- **Settings are one sheet with tabs**: Overview, Personality, AI, Data,
  Telegram, Slack & Discord, Sharing, Schedule, Advanced. **Overview** sets
  its group and class; **Telegram** holds the agent's bot (add, remove,
  members, group chats, formatting); **Data** is delineated into Folders, Git
  repos, Connections and History; **Slack & Discord** is under construction
  (see *Slack and Discord* below). The editors live right in those tabs, not
  one panel deeper. Every button from the classic card is in one of them.
- **Every panel slides in from the right** with **‹ Back** at the top. Panels
  stack: Back returns to whatever opened it.
- **Machine settings have nine tabs**: You (your account, other accounts,
  "about you"), AI (sources), Classes (agent classes), Telegram (the bot
  pool), Connections (Google accounts, plus the voice-notes and web-search
  keys), Hosts (runners, other Hatchabot servers), Images (base images first —
  try a candidate on one agent, promote, delete; building one is the Hatchabot
  agent's job, not a form here — then derived images), Backups, Security.
  Every section on every tab is drawn inside its own outlined card.
- **Check an agent's health on its Overview**: the result appears right
  there, not in another panel.
- Long introductions show two lines; **More** reveals the rest.
- **Hatchabot itself is at the top**: your manager, with the fleet in tiles
  beside it. Click it to talk; ask it to create, fix, move or share agents.
  Every change arrives as a card showing exactly what it will do, and nothing
  happens until you press its Confirm.
- **Icons are picked for you.** The first time the new screen sees agents
  without one, your management AI chooses an emoji and colour for each from
  its name and description (or, with no AI set up, a keyword table does).
  Change any of them by clicking the icon in its settings. Icons travel with
  the agent: backups, shared copies and agents sent to someone else keep
  theirs.

## Your Hatchabot agent (the manager)

The box at the top of the home screen offers **Set it up**: a management agent
of your own, one per account. It is an ordinary OpenClaw agent, so it runs on
**whichever AI source you have** (Claude, OpenAI, Gemini or a local model),
has the full console, remembers how you like things run, and can have a
Telegram bot added later. **💬 Open** talks to it.

It can look at everything about your agents (health, logs, usage, their files
and memory) and it can *prepare* changes: archive, rebuild, switch AI source,
scheduled tasks, images and the rest. It cannot carry any of them out. What it
prepares appears under **Waiting for you**, on the home screen and above the
conversation, and happens only when you press **Confirm**, with your own
sign-in. Replying "yes" in its chat approves nothing, on purpose.

**It tells you what to add.** Naming what to delegate is the hardest part of
starting, so the app hands that question to the one thing that can answer it
from evidence: *Not sure what to make? Ask Hatchabot what you're missing* — in
the New agent panel, and on the home screen while the fleet is small. It reads
your agents first and suggests what is **missing beside them**, saying what made
it think so; with nothing to go on it asks two or three short questions instead.
What you like becomes ordinary `create_agent` cards — one per agent, nothing
created until you Confirm. Its Monday check goes further: it looks at the three
busiest agents' logs for one being asked things outside its job, or carrying
two, and offers the split with the evidence quoted.

**It tells you what happened.** When a change it filed is confirmed or
cancelled, and when a background build ends, Hatchabot posts a short note into
the agent's own conversation, so the console says how it went instead of going
quiet. Give the agent its own Telegram bot (its ⚙ Settings → Telegram) and a
waiting change is also pushed to your phone through that bot — one way:
nothing is ever approved from Telegram, the card is still pressed in the app.
It can also read the outcome of anything it filed with `list_proposals`.

Three things keep that true even if the agent is misled by something it reads
(details in `docs/ops-agent-design.md`):

- **A limited key.** Its key to Hatchabot can only read and propose.
- **No internet.** Its container reaches only a small Hatchabot server. That
  server offers the tools, and a filtered route to its own AI provider (plus
  Telegram, if it has a bot).
- **Locked-down tools.** No shell, web or browser tools.

More about it:

- **Cards say who and how risky.** Each card says who prepared it and how much
  care it deserves ("Restarts or interrupts something", "Read carefully"), and
  shows the agent's own reason, marked as its words.
- **Approve from your phone.** Give the Hatchabot agent its own Telegram bot
  (its ⚙ Settings → Telegram) and you can ask it for a change from anywhere;
  Hatchabot also pushes what needs you — someone asking to join, a card
  waiting — down that channel. The confirmation itself happens in the app,
  where the card says who prepared it and what it will run. (The separate
  Telegram management bot that used to carry Confirm/Cancel was removed in
  v2.0.0.)
- **It can search the web without having internet.** Hatchabot runs the
  search, and the agent can open only the results that came back.
- **A morning fleet check** is set up as an ordinary scheduled task (08:00).
  Pause or delete it from its Schedule tab.
- **Tampered safety settings pause it.** If someone loosens its tool settings
  from the console, Hatchabot notices within minutes and pauses its access.
  **Rebuild** restores the settings.

It is also pinned to the OpenClaw version it was created on, so a bad upgrade
can't take your manager down with the fleet. Secrets, deleting agents,
promoting a base image and accounts stay in the app.

Until you set one up, the older built-in chat remains in that box where a
Claude source exists.

## Creating & talking to agents

**Telegram is optional.** Tick **No Telegram** when creating an agent (or
`hatchabot create <name> --no-telegram`) and it uses no bot at all: you talk to
it by clicking its icon, which opens its OpenClaw console. Add a bot later from
its Overview (**Add a Telegram bot**: instant from your pool, or paste a
BotFather token) when you want to reach it from your phone or invite people.
**Remove…** on the same row does the reverse. The bot goes back to your pool,
its Telegram contacts get a goodbye, and you keep talking to it in the app.
Memory is untouched either way. A bot-less agent's backups and shared copies
work as usual; moving one to *another Hatchabot server* needs a bot, so use
Download copy and import it there instead.

To create an agent, tap **+** in the web app: name it, optionally answer
"What is it for?" (that text becomes its persona), pick an AI source, and —
when more than one host exists — pick where it runs ("Runs on"). A "Keep
memory private" checkbox decides shared vs private memory at birth.

Every agent needs a Telegram bot — its identity on Telegram. Telegram has no
API to mint bots, so normally you're walked through creating one at
[@BotFather](https://t.me/botfather) and pasting its token (~60 seconds).
When you delete the agent, the bot still exists on Telegram's side — and its
token isn't lost: delete parks it in the Bot pool by default (API callers can
opt out with `?recycleBot=0`), ready for a future agent.

Bots outlive agents by default: **deleting an agent parks its bot in the
Bot pool** (⚙ Settings → Bot pool) — pool-leased and hand-pasted alike — and
when the pool leases it to the next agent, the bot's display name updates to
that agent's name automatically. **Bots are personal**: a token belongs to
whoever minted it at BotFather (they can rename or revoke it any time), so
each user leases only their *own* parked bots plus **shared** house bots
explicitly donated for the whole server. With Telegram's
~20-bots-per-account ceiling, every recycled slot counts; remove a bot from
the pool tab if you truly want its token gone. You can also pre-stock the pool there (paste
BotFather tokens; verified before storing), after which creation grabs a bot
instantly — the header shows "N instant bots ready" and the create dialog
lets you opt out per agent for a bespoke @handle. (Server-side stocking:
`HATCHABOT_SECRET_KEY=… npx tsx scripts/pool-add.ts <token>…`.)

**A recycled bot keeps its old chat.** When a pooled bot is leased to a new
agent, Hatchabot renames it, clears its description and command menu, and posts
a marker to everyone who talked to the previous agent ("this bot is now X —
anything above this line was a previous agent"). It cannot remove the old
conversation: the Telegram Bot API only deletes individual messages under **48
hours** old (`deleteMessage`, or `deleteMessages` for up to 100 at once), and
there is no method that clears a chat or starts a fresh thread — renaming a bot
changes nothing about the history already in someone's client. The marker
message therefore tells the person how to clear their own copy, which is the
only control that exists. If a clean slate matters, mint a new bot at
@BotFather rather than recycling one.

**Whose bot is whose**: a bot you park is *yours* — only your agents lease it,
and only you (or the machine owner) can remove it. Any account may park one it
minted at @BotFather. Ticking **Share with everyone on this server** donates it
to the house pool instead, which is the machine owner's call and hidden from
other accounts.

**Group chats**: two @BotFather settings gate a bot in a group —
`/setjoingroups` Enable and `/setprivacy` Disable (privacy left on = the bot
only sees /commands and @mentions). Neither is settable by API, but ⚙
Settings → Telegram → **👥 Group chats** shows the quick-help steps and a
live check of both toggles for that bot (re-add the bot to existing groups
after flipping privacy — Telegram isn't retroactive). The same panel sets
**who may talk to it in groups**: *Members only* (default — the group is a
shared surface for people you've admitted; accidental addees are ignored),
*Nobody*, or *one chosen room* where being in the room is the invite —
mention-gated, bound to a single chat id, never channel-wide. DM pairing
stays the core access model. Applies on the next Rebuild.

**Several agents in one room** is supported: point each one at the same room
and the panel names the others already there. Each agent is its own bot and
answers only its own @mentions, so a board room can hold a minutes-taker, a
legal advisor and a bookkeeper at once. One limit comes from Telegram itself —
it never delivers one bot's message to another bot, so agents in a room cannot
read each other's replies. When they need to consult each other, connect them
as **peers** (A2A) instead; that path is direct and doesn't go through the
room.

**What a peer may do.** A consult is relayed as *untrusted* input: the peer
answers from knowledge and is told not to act on it, because anything that can
steer one agent — an injected email, a message from someone in its chat —
would otherwise reach into another agent's mail, files and calendar. For a pair
you drive on purpose (a QA agent resetting the system it tests), tick **may act
on its requests** beside that peer in the **Peers** tab: one direction, both
agents yours, confirmed in the app, and recorded in the timeline. It never
relaxes the rule against handing over credentials. A consult runs the peer's
whole turn inside `HATCHABOT_A2A_TIMEOUT_MS` (120 s by default) — raise it for
tool-heavy work.

Tap the **agent's name** on its card (it's the Telegram deep-link; Telegram
Web lives in the ⋯ menu) and say hi. Your first-ever message claims
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
  bad edit is always undoable. (CLI: `hatchabot snapshot` / `revert`.)

**📝 Chat → Memory** (card) asks the agent to write the current
conversation's key facts into MEMORY.md now (~20s) — a checkpoint, so the
context survives a reset. The same checkpoint is offered as a checkbox when
switching an agent's AI source (and on the bulk switch-and-rebuild), because
a backend switch resets the live Telegram thread.

**Rebuild** (on the card) replaces the container but keeps the volume —
containers are cattle, volumes are not. Only **Delete** purges, and it makes
you type the agent's name.

**When a rebuild costs the chat.** A rebuild keeps the volume, so memory,
files and members survive — but OpenClaw can still end the *conversation*
(an idle reset, or a source switch), and an agent that has forgotten this
morning's thread is the thing people fear about rebuilding. Hatchabot now
checks after every rebuild: OpenClaw marks an ended conversation by renaming
its file to `*.jsonl.reset.<time>`, so the answer is in the session files
rather than in anyone's memory. If one was reset, the agent's card says so —
*"Its chat started fresh 2h ago — 148 earlier messages are no longer in its
context"* — with **📥 Recover context**, which stages the old conversation into
its workspace and has it save what matters, and **Dismiss**. A later reset is
news again even if an earlier one was dismissed.

## Copying & moving

Five distinct verbs, for five intents:

- **⧉ Clone** (card) — duplicate the agent on this machine: a faithful copy,
  memory included, with its own bot and name. CLI: `hatchabot clone`.
- **📤 Share** (card) — export a **template** for someone else: the trained
  SOUL.md + AGENTS.md — plus memory if you say so (the web asks: OK for a
  faithful copy, Cancel for persona & instructions only; the CLI leaves memory
  out unless `--include-memory`) — the AI vendor preference, and a checklist of data sources and
  env-var *names* — but **no bot token, members, or conversation history**.
  Safe to email. The recipient uses **Import** (header) to stand up a fresh
  agent with their own bot, AI source, and people.
- **Import** (header) — opens any `.hatchabot` file and auto-detects it: a
  full backup is restored as the *same* agent; a template becomes a *fresh*
  one.
- **Download copy** (card ⋯ menu) — a complete private copy to a file (bot
  token, members, memory) for your own keeping; restore it anywhere with
  `hatchabot restore`. Don't share it.
- **Move** (card, shown when more than one host exists) — relocate the agent
  to another **runner in this cluster**: it stops, its volume is copied to
  the target host, and it starts there. Same agent record, same bot, same
  members; any failure rolls it back where it was. While it moves the card
  shows a pulsing **WORKING…** chip.
- **Move to another cluster** (card ⋯ menu) — send the agent to a different
  Hatchabot server entirely (registered under ⚙ Settings → Cluster servers).
  It transfers with memory, members, and Telegram identity, and is managed
  from that server's dashboard afterwards. The local copy stays STOPPED —
  never start both, they'd fight over the same bot. CLI: `hatchabot rehost`.

**📨 Send** (card) skips the file when the recipient is on this server: pick
them by email and the same secret-free template lands in their **📥 Inbox**
(header button, with a pending-count badge), where they **Import** or
**Dismiss** it. A send to an email that hasn't signed in yet waits and binds
to that account on its first sign-in. Identity mode only — on a single-login
box, Share to a file instead.

**Setup fields** make a shared template *operating*: write `{{investment_style}}`
into SOUL.md (or AGENTS.md, or the persona) and anyone importing the template is
asked to fill it — export auto-derives every hand-written placeholder as a
required field, no declaration needed. For nicer forms, declare fields in
📖 Definition → **Setup fields**: label, help text,
text/longtext/choice/multichoice/boolean, default, required. A field can
target a file placeholder or an **env var** (target `env`): the importer's
answer is masked on entry and becomes a write-only agent env credential —
so a template can ask for its API key at import instead of a manual
Environment step. The importer's
answers substitute into the seeded files before the agent boots (web renders a
form on file-import and inbox-accept; the CLI prompts). The template carries
field *definitions and defaults* only — never the author's own filled values.
Values stay editable afterwards: 📖 Definition → **Setup values** edits or
resets any answer in place (snapshot first), on imported copies AND on the
master itself (its layer seeds from the live files on first Apply).

**Master → child agents** (the productization pattern): on a master (an
agent with setup fields), **👪 New child** derives a copy — same training,
the child's own setup answers and credentials, its own bot, fresh memory —
and children render **indented under the master's card**. **⬇ Push to
children** re-renders every child's SOUL/AGENTS from the master's *current*
files, keeping each child's own values (snapshot per child; MEMORY.md never
touched). Lineage is also recorded when you Clone, or when a 📨 Send is
accepted on the same server. Child→master distillation ("propose this
learning back to the master") is the designed next step.

**Web search is on for every agent** (keyless DuckDuckGo baseline; the
config is written explicitly on every rebuild). Upgrade the whole fleet to
Brave with one **Fleet search key** (⚙ Settings → Media — write-only, same
sharing caveats as the media key); a per-agent `BRAVE_API_KEY` env var (or
an env-target template field) overrides it with that agent's own quota.
Provider auto-detection comes from the key names.

Environment variables travel with a full copy: Download/Restore and
cross-cluster moves carry each var's name **and** value (the archive already
holds the bot token — guard it like a password). Shared templates still carry
names only. Rules and formats: [moving-agents.md](moving-agents.md).

## Adopting existing OpenClaw agents

If you already run hand-built OpenClaw agents, bring them in from
**New agent → "Already built one in OpenClaw? Bring it in →"**. The dialog
**discovers** every OpenClaw agent installed for this server's user (from
`~/.openclaw/openclaw.json`), annotated with its bot and whether it's already
in Hatchabot. Tick any and **Bring in selected**. For each one, adopt:

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
`hatchabot adopt <workspace-dir> <name> [--reuse-bot] [--bot-token <tok>]` —
`--reuse-bot` takes over the workspace's existing bot instead of spending a
new bot slot.

## Data & secrets

**⚙ Settings → Data** — what the agent can read beyond its own workspace:

- **Folders** — a host directory bind-mounted at `/data/<folder>`, read-only
  by default (kernel-enforced; credential and system paths are refused).
  Writable folders exist but are machine-owner-gated and warned: anyone who
  can message the agent can ask about — and for writable, change — those
  files.
- **Git repos** — first-class: Hatchabot generates a repo-scoped **deploy
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
- **Several apps?** The join page asks which one they'll use (Telegram,
  Slack or Discord) and gives them that app's link.
- **Off your network?** Send the agent's Telegram link (or the QR code)
  instead. When they message it, a "wants to talk" card appears on the agent
  and **Let them in** makes them a member.

Members show on the card (when there's more than one) and always under
⚙ Settings → Telegram → **Members** — role, Telegram-link status, Remove,
and Invite… in one place. CLI: `hatchabot invite`, `approve`, `deny`,
`members`, `kick`.

## Slack and Discord

> **Coming — hidden by default (v2.3.0).** Everything below is built and
> covered by tests, but it has never been run against real Slack or Discord
> apps, so the app does not offer it yet: an agent's **Messaging** tab says
> Slack and Discord are coming. Turn them on in your own browser with
> `?preview=channels` (remembered, like the classic look; `?preview=0` turns it
> back off) — the server keeps its routes either way, so this is a place to
> work, not a demo. An agent that already has a channel attached keeps showing
> and managing it whether or not preview is on.

An agent can also be reached on Slack and on Discord, beside or instead of
Telegram. Both connect outward from this machine, so nothing here has to be
reachable from the internet. Each agent gets its own Slack app or Discord bot,
which you make on that platform and paste into **Messaging → Set up…**. The
sheet walks through it in three steps; it takes about five minutes.

- **Slack** needs two tokens from one app: the bot token (`xoxb-`) and an
  app-level token (`xapp-`) with `connections:write`. **Copy app manifest**
  gives Slack everything else (Socket Mode, scopes, events), named for the
  agent. A free Slack workspace allows 10 apps.
- **Discord** needs the bot token, with **Message Content Intent** turned on.
  After connecting, **Add to a server** puts the bot in one of yours; people
  can only message it once they share a server with it.
- Hatchabot checks what you pasted with Slack or Discord before saving it,
  and says in plain words what is wrong (a token in the wrong box, a missing
  scope, the intent turned off). Tokens are stored like every other secret and
  never shown to an AI.
- **People**: your first direct message links you, as with Telegram. Others
  join with an invite link, where they choose the app they'll use, or by
  messaging the bot and being let in from the "wants to talk" card, which now
  says which app they came from. Removing a member takes them off every app.
- **Group chats** are off by default. You can let it answer in one Slack
  channel or one Discord server, by its ID; there it answers members only,
  and only when @mentioned.
- **Needs a base image that includes them.** Images built from v1.31.0 carry
  both plugins (label `org.hatchabot.channels`); an agent on an older image
  shows "its base image can't do Slack yet".
- The Hatchabot agent can take an agent off Slack or Discord
  (`remove_channel`), but connecting one is app-only, because it takes tokens.
  Slack and Discord are not offered for the Hatchabot agent itself yet.

Design and the verification notes: `docs/channels-slack-discord-design.md`.

## The base image

Every agent runs the same base image: OpenClaw, the Claude CLI, Python, the PDF
and OCR tools, the messaging plugins, and the usual shell tools — including
`ping` and `dig`, so "can it reach that?" needs nothing extra.

Need something else in it? Ask your Hatchabot agent: *"build a base candidate
with tcpdump"*. It comes back as a card naming the packages; confirming builds
a **candidate** with its own tag (`2026.7.1-2-plus-tcpdump`). Nothing changes
for any agent until you try it on one from Settings → Images and then
promote it. At most eight packages, apt names only, and an image with extras is
never built as the fleet default directly.

For one agent's own libraries — a Python stack, a CLI only it needs — a
**derived image** is still the lighter answer: it layers on the base and only
the agents you pin to it carry the weight.

**Settings → Images** lists every image on the machine as one table — tag,
what it is (fleet default, candidate, older build, derived), what it carries
("with Slack and Discord · plus traceroute"), what uses it, and its actions.
**🧪 Try** opens a picker: filter by name or group, tick as many agents as you
like, and **Pin & rebuild _n_** pins each and queues the rebuilds (memory kept,
six at a time). An agent's own pin lives in its ⚙ Advanced → Runtime image as a
dropdown of every image with a line saying what each one is, and **Fleet
default** at the top to put it back.

## Fleet operations

**📊 Health** (header) is the fleet dashboard: counts (running / stopped /
failed / working), a "needs attention" list (failed agents with their reason,
agents waiting for a bot, running agents idle over 14 days), and a per-agent
line with state, model, and last activity. The host owner also sees **backup
health** (latest set and its age) and **runtime** (image version, upgrade
available). **Run health checks** probes each running agent's in-container
gateway live.

**📊 Usage** (header) is the fleet rollup: every running agent ranked by
cumulative tokens, with a bar per agent, its session count, last activity, and
an **estimated API cost**. Cost is honest about its limits — only API-keyed
agents have a per-token price (subscription and local agents show
"included" / "local", both $0), and since OpenClaw reports one combined
input+output token counter, the figure is a *range* (low = all input, high =
all output; the true cost sits near the low end for context-heavy agents). A
trailing `+` means a model had no known price and was left out. Usage is read
live from each container, so stopped agents aren't counted — they show as "N
not counted (live-only)" rather than as zero. On the CLI, `hatchabot usage` (no
agent name) prints the same ranked table with cost; `hatchabot usage <agent>`
still shows one agent's breakdown by model.

**📊 Sources** (header) answers "who runs on what": each AI source with its
credential kind, the agents on it and each agent's current model (pins and
pending switches flagged), plus a models-in-use tally. The card's status line
also names each agent's AI source (when more than one exists) alongside its
model, bot, and host.

Per-agent, the card's ⋯ menu has **📊 Usage** (tokens by model,
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
runners); a **Mesh** is independent Hatchabot servers peered as **Cluster
servers**, with "Move to another cluster" carrying agents between them. See
[topologies.md](topologies.md), and [deploy-gce.md](deploy-gce.md) for
running a node on a cloud VM.

Agents know where they run: ask one in Telegram which machine it's on and it
can check — its container hostname is `<agent>.<host>` and
`HATCHABOT_HOST_NAME` carries the host's name, both refreshed on every
rebuild and Move.

## Google connections (Gmail, Drive, Calendar, …)

Advanced agents can connect to Google Workspace via the bundled `gog` CLI
(seeded as a skill in every agent). Setup happens **in the Telegram chat**:
ask the agent to connect an account and it walks the owner through Google's
consent flow (`--remote` paste-back — no browser needed on the server).
**Multiple accounts per agent are supported**: auth each one in chat
(`board@`, `treasurer@`, …) and every gog command selects its identity with
`-a <email>` — tell the agent which account serves which duty and it records
that in its playbook.
Credentials land on the agent's own volume (`GOG_HOME`), so they refresh in
place and travel with Move, backups, and Download — while Share templates
never include them. Recommend a **purpose-bound Google account** (scoped to
the agent's job) and minimal services: everyone who can message the agent
can act as the connected account. Design and phases:
[connections-design.md](connections-design.md).

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

**The list is in the order you put it in.** ▲▼ on each source moves it, and
that order is what every list of sources shows — the create form, an agent's
AI tab, a class. A local model that is rarely the right answer belongs at the
bottom instead of being the first thing offered; making a source the **⭐
Default** lifts it to the top, where it belongs. A new source lands at the
bottom, and a source shared to you by someone else can be moved past but not
moved.

Each agent picks its source in **⚙ Settings → AI**, and cloud agents can
additionally pin any **model** from that source's list (or follow its
default) — one Claude source can drive a cheap model for simple agents and a
top model for demanding ones. Applies on the next Rebuild.

**Changing a source's default model** on a source that has agents opens a
"which agents adopt it" dialog rather than silently switching everyone: tick
the agents that should move to the new model (and rebuild them now, or on their
next rebuild), and every un-ticked agent is **pinned to the model it runs
today** so it never drifts. Agents that already pin their own model start
un-ticked and protected. (Local sources run one model for the whole GPU, so
they set-and-rebuild without the picker.)

A profile's **Shared** toggle lets every account on this server use it for
their agents. That is a credential hand-off, not a metered proxy — share only
with people you trust with the underlying key. Full detail:
[ai-profiles.md](ai-profiles.md).

## Archiving — more agents than bots

Telegram caps an account at roughly 20 bots, and every agent holds one whether
it is busy or idle. **Archive** (⋯ menu on the card) breaks that ceiling: the
agent is kept whole — container, volume, memory, members, settings — and stops,
but its bot goes back in the pool for another agent to lease. A pasted,
hand-minted token is parked in the pool too; it burns the same BotFather slot,
so it is just as worth recycling.

The one thing archiving does not preserve is the **chat address**. Members are
told so in the chat, by the old bot, before it is renamed:

> — archived — This agent has been put away for now. Nothing was lost… If it is
> brought back it will be on a NEW bot — ask whoever runs it for the new link.

**Restore** leases a fresh bot and boots the agent with everything it has
learned — SOUL/AGENTS/MEMORY and the rest of its workspace — intact. It is
a re-provision rather than a start, because the identity has to be leased again;
the new bot has a different `t.me` link, which you send from **Invite…**. Nobody
has to pair again — Telegram user ids are global rather than per-bot, so the
allowlist rebuilds itself.

One caveat that is **not** specific to archiving: an agent's Telegram thread can
end for reasons outside Hatchabot's control (a `/new` or `/reset` in the chat,
and possibly other triggers — see `docs/pre-production.md` §9, which is honest
about what is still unexplained). Archiving itself never deletes a transcript;
the previous one is kept beside the new one as `<session>.jsonl.reset.<timestamp>`
in the agent's session store.

Archive from RUNNING, STOPPED, or FAILED — a broken agent still sits on a token
somebody else could use. Archived agents collapse into a closed **Archived**
drawer at the bottom of the fleet, out of the sections you actually run, with a
single line in the jump legend.

On the card, **Archive** sits where Stop used to; Stop moved into the ⋯ menu,
since pausing an agent keeps its bot and that is rarely the point. The same slot
becomes **Restore** once archived. From the CLI: `hatchabot archive <agent>` and
`hatchabot unarchive <agent>` — *not* `restore`, which already means "restore
from a downloaded .hatchabot file".

## Adding tools to an agent

The runtime image is deliberately minimal and shared; tools belong to the agent
that needs them, on its own volume, installed **through chat with the agent**.
Every agent's `TOOLS.md` carries a managed "Installing tools" section (synced on
every rebuild) that teaches it the rules of the house: no root and no apt;
static binaries into `~/.local/bin`; `npm install -g` (lands in
`~/.npm-global`); `pip install --target ~/.openclaw/pylibs`; OpenClaw skills via
`openclaw skills install`; and `~/.openclaw/on-rebuild.sh` for anything that
must be reconstituted outside `$HOME` after a rebuild. All of it survives
rebuilds because the agent's whole `$HOME` is the durable volume.

The base image itself changes rarely and deliberately — OpenClaw/Claude Code
version bumps via the candidate → smoke → promote flow in
`scripts/build-runtime-image.sh`, or a system package no static build can
substitute for.

**Per-agent image pin** (an agent's ⚙ Advanced → Runtime, host owner only): pin one agent
to a specific image — a candidate build under test, or a derived image with
extra system packages — instead of promoting fleet-wide. Applies on the next
rebuild; the card shows 📌 with the pinned tag; a pinned agent stops getting
"update available" from fleet promotes, since it deliberately doesn't track
`:latest`. Clearing the field returns it to the default.

**Derived images** (⚙ → Images, below the base images, or `hatchabot image`,
host owner only):
the first-class form of "this agent's owner needs ffmpeg + LaTeX". An image
`FROM hatchabot-runtime:<base>` plus Dockerfile lines — for system packages
(apt) a volume install can't provide — that an agent is then pinned to. In the
app you **ask the management agent** for one ("build an image with ffmpeg"): it
writes the lines and files the change, and nothing builds until you press
Confirm — the web form that used to take raw Dockerfile lines is gone, since
getting them right by hand is expert work. The tab lists every derived image in
one table (state, contents, what pins it) with Rebuild, Log and Delete. Your
lines run as **root** (the base ends as `USER node`), then the image restores
`USER node`, the runtime contract the volume (uid 1000) and Claude Code depend
on; you never write your own `FROM`/`USER`. The image is tagged
`hatchabot-runtime:derived-<name>`; the Dockerfile is kept so **Rebuild**
reruns it against a promoted base after a fleet upgrade. Delete is refused while
an agent still pins it. From the CLI:
`echo 'RUN apt-get update && apt-get install -y ffmpeg' | hatchabot image derive media`,
then `hatchabot image pin <agent> media`. Building runs a Dockerfile on the box,
a privilege the local-host owner already has — so it, and the pin, are
host-owner gated and never exposed to a co-tenant.

## Bots census

Telegram caps an account at about 20 bots and offers no API to list them —
`@BotFather → /mybots` is the only complete list. Paste it into **Settings →
Telegram bots → Compare with BotFather's list** and the app names the strays
(at BotFather, unknown here), the ones known here but missing from the paste,
and the matched-but-dead. `scripts/mybots.py` prints that list for you, but it
signs in as your Telegram *account* over MTProto — run it on your own machine,
never on the server, and delete its session afterwards. Meanwhile,
`hatchabot bots [--check]` enumerates every bot this install (and each
registered peer server) uses: **in-use** (a running agent), **reclaimable**
(a stopped/failed agent, or an unleased pool bot), or **dead** (`--check`
asks Telegram). A `⇄ also` marker flags a bot appearing in two places — a
move or adopt leftover. Anything it can't see, check at @BotFather →
`/mybots`.

## CLI + management bot

The `hatchabot` CLI speaks the same API as the web app — create, list, logs,
snapshots, moves, adopt, backups, health, usage, and more. Run
`hatchabot help` for the full list; configure it via
`~/.config/hatchabot/env` or mint a token in **⚙ Settings → Security** and
`hatchabot login`. That tab also lists the tokens this account has minted —
what each is called, when it was made and last used — with **Revoke**.

Managing the fleet from chat is the **Hatchabot agent's** job (see *Your
Hatchabot agent* above). The separate Telegram management bot that used to do it
was **removed in v2.0.0**; the broker it shared with the app — propose, confirm,
execute — is what the agent files its cards through. If one is still running on
an older install: `systemctl --user disable --now hatchabot-mgmt-bot`, delete
`.env.mgmt`, revoke its token under ⚙ Settings → Security, and `/deletebot` the
bot at @BotFather.

## Smoke test

`npm run smoke` runs a fully isolated end-to-end test: a throwaway control
plane on its own port and Docker namespace adopts an agent against real
Docker and a real Telegram bot, then tears everything down — it never touches
your real server or agents. Put a throwaway BotFather token in a git-ignored
`.env.smoke` at the repo root (`HATCHABOT_SMOKE_BOT_TOKEN=…`); without one
the test skips cleanly, so it's safe in CI or cron.
