# Why Hatchabot — philosophy and what it actually does

## The idea in one paragraph

Claude and ChatGPT give you **one excellent assistant, in one app, from one
company, for one person.** Both remember you now, and both let you view, edit
and export what they remember. The difference is where it lives and who uses
it: a Hatchabot agent's memory is a plain file on your disk that the agent
reads directly. You can back it up with everything else, run it under another
model, or move it to another machine, without anyone's export button.
Hatchabot is the opposite shape: **many purpose-built agents, on hardware you
own, thinking with whichever AI you choose, reachable by whoever you let in,
through the messaging app your family already uses.** It is not a chatbot. It
is the control plane for a small fleet of them.

## Principles

**Agents are things you own, not sessions you visit.** Each agent is a
container with its own persona (`SOUL.md`), operating instructions
(`AGENTS.md`) and memory (`MEMORY.md`) — plain files on your disk that you can
read and edit, snapshotted before every change. An agent persists across
restarts, rebuilds, model switches and even moves between machines. What it
knows about you accumulates for years, and it's yours.

**Memory is a file, not a chat log.** The agent writes durable facts as it
goes; you can ask it to save a conversation to memory, download its entire
chat history, or recover the context of a conversation that was reset. Nothing
important is trapped in a transcript.

**Not locked to one lab.** Anthropic (subscription or API key), OpenAI, Google Gemini,
or a local model server with no account at all, per agent. Switch models
within a source instantly; switching providers takes a rebuild and starts a
fresh conversation, with memory kept. Put simple agents on a cheap model and the demanding ones on
the best; group them into classes and retune a whole tier in one place. Your
agents outlive any one provider's pricing decision.

**The front door is Telegram.** No app to install for the people you invite, no
account with anyone but Telegram. Chat with an agent like a contact. Several
people can talk to the same agent, one to one or together in a group room. It
has one memory and one conversation for direct messages, and everyone it lets
in is told so. For something private, give that person their own agent. (Slack,
Discord and Hatchabot's own web chat work too.)

**Isolation by construction.** One container, one bot, one set of credentials
per agent. An agent can be given exactly the data it needs (a folder, a git
repo, a Google account whose mail tool has sending switched off — a tool
setting, not a Google permission, so don't rely on it against someone
determined) and nothing else. The security posture check tells you, every day, which agents
have both a wide audience and a powerful capability.

**Claude Max, on purpose.** A Max subscription is consumer pricing — a flat
monthly plan — and `claude setup-token` turns it into an API-like credential
Hatchabot can inject into every agent. So a household of always-on agents
(schedulers polling inboxes, advisors reading mail, a dozen personas) runs on
one flat fee instead of per-token metering from any lab. For this kind of
fleet that's the difference between "affordable" and "a bill you watch".
Usage limits still apply (a burst of simultaneous turns can hit them). Anthropic's
rules for third-party use of a plan changed several times in 2026. In
September 2026 such use drew from the plan's normal limits. On 7 October 2026
Anthropic said the separate "Agent SDK credit" announced earlier is no longer
available, and that Max and Team plans now include monthly API credits ($100
or $200 a month on Max) for the Claude API and the Agent SDK, claimed into a
Claude Console organization and used with an API key from it
([support.claude.com](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans)).
Such a key is an ordinary API-key source here. Check the plan's current terms
before relying on it. The
setup-token is exactly what makes the credential portable: one token per
account, injected per agent, revocable, never a shared login directory.

**Telegram, on purpose.** It's free, it's on every platform, and bots are a
first-class part of it: BotFather creates one in a minute, a free account can
own 20, Telegram Premium raises that to 40 — and more accounts in the household
add more. Every agent gets a real, separate identity people already know how to
message, with deep links, group chats and per-agent allowlists for free. No app
to ship, no accounts to run, no notification system to build.

**Every operation is reversible or honest about not being.** Snapshots before
edits and rebuilds, rollback on a failed move, a full audit timeline of what
happened to which agent, usage reported as tokens rather than a made-up bill,
and health probes that distinguish "listed as running" from "actually
answering".

## Versus plain OpenClaw

Hatchabot doesn't replace OpenClaw — every agent *is* an OpenClaw gateway. What
it adds is the layer OpenClaw deliberately doesn't have: many installs, run as
a fleet, by more than one person.

- **One install per agent, so agents can't hurt each other.** Plain OpenClaw is
  one gateway, one process, one `openclaw.json`, one workspace and credential
  set shared by every agent in it. Hatchabot gives each agent its own container,
  volume, bot token, tool policy and secrets. A runaway task, a bad config edit,
  or a crash touches one agent — the other thirty keep answering. Agents on
  the same subscription share its limits. Upgrades work the same way: the runtime image
  is pinned and rolled out per agent (candidate first), never "upgrade the
  gateway and hope every agent survives".
- **Lifecycle instead of hand-editing.** Create, clone, rebuild, archive,
  restore, delete, move between machines — with a snapshot before every change
  and a rollback if a move fails. In plain OpenClaw that's you, a shell, and a
  directory.
- **Credentials managed once, injected per agent.** One Claude setup-token
  serves every agent; Google accounts attach per agent, with sending switched
  off in the mail tool if you like; per-agent secrets are write-only. No keyrings to hand-copy into each
  install.
- **More than one human.** Owners, members, invites by link or QR, pairing
  approvals, group rooms, a shared memory that everyone is told about,
  per-owner isolation for a household. OpenClaw's allowlist is a config line.
- **Fleet operations.** One app for the whole fleet: health probes, usage per
  agent per day, an audit timeline, a daily security posture with diffs, classes
  to retune model tiers, bulk actions, planned agents.
- **Continuity across the things that reset a thread.** Save-to-memory before a
  source switch or archive, full chat export, one-click recovery of lost
  context, an operator profile injected into every agent.
- **Agents that consult each other across installs** — with owner-granted,
  scoped tokens, loop guards and rate limits — instead of everything sharing one
  process.

If you run one agent for yourself, plain OpenClaw is fine. Hatchabot is for
when there are several, they matter, and other people talk to them.

## What you can do that you can't do with a chat app

| Capability | What it means in practice |
|---|---|
| **Create agents fast** | Name + one paragraph + a bot token → a running, remembering agent in a minute. Clone one you like; import a shared template. |
| **Talk through Telegram** | You and your family message agents like contacts. Invite by link or QR; group rooms; per-agent allowlists. |
| **Many humans, one agent** | Several people on the same agent, or a shared room. One shared memory, declared to everyone who joins. |
| **A supervisor for the models** | Your Hatchabot agent keeps each agent on the least capable model that does its job well (cheaper or stronger), from a weekly scorecard of evidence; every change recorded, a quality guard that proposes switching back if errors rise, the realised saving and each agent's weekly cost shown (estimates at API list prices); loops flagged under Alerts, and compaction or a conversation cap proposed when a conversation grows large. You confirm every change. ChatGPT's Auto picks a model per message inside OpenAI's app; here it is per agent, under your control, with the savings shown. |
| **Choose the brain per agent** | Claude, OpenAI, Gemini, or a local model; switch models within a source instantly; a provider switch takes a rebuild and starts a fresh conversation, with memory kept; classes for tiers. |
| **Give agents accounts and data** | Gmail / Calendar / Drive / Sheets connections, folders, git repos it commits to, per-agent secrets. |
| **Schedule and react** | Cron tasks, event-triggered tasks (a zero-cost check decides whether to wake the model), run-now tests. |
| **Agents that consult each other** | Grant an investing agent access to your tax and legal agents; it asks them mid-task. |
| **Master → child lineage** | A "master" agent's improvements distil into proposals that push to its children. |
| **Move, copy, share, back up** | Move to another Hatchabot server in one step; download to a file; share as a template with no bot, members or secrets (you choose whether its memory goes too); scheduled backups. |
| **Rebuild without fear** | Rebuilds keep memory; only a change of AI *source* resets a thread — and that offers to save memory first. |
| **Multiple machines** | Add runners (a laptop, a second box) and place agents where they fit. |
| **See what's going on** | Fleet health, usage per agent per day, audit timeline, security posture with daily diffs. |
| **Know and cap what each agent costs** | Every agent's spend at API prices on its tile, by what it went on and by model; who spends on each AI source; a monthly budget per agent or for the machine, with a warning, a cheaper model or a pause at the limit, and "tell me every $X". |
| **Many consoles, one window** | A tab per agent, ⌘K to switch, an address per console you can bookmark. |
| **Fixes that start from its own code** | Your Hatchabot agent checks a playbook of known problems, then reads the code of the release you run. Any coding assistant opened in the Hatchabot folder reads the same playbook through `AGENTS.md`. Report a problem files a masked GitHub issue that you submit yourself. |

## What it does that the chat apps don't (October 2026)

Claude and ChatGPT are excellent and change every month, so each point here
is narrow and dated. Checked 2026-10-07 against Anthropic's and OpenAI's own
help pages, except where a point gives another date.

- **The people you invite need no AI account.** Sharing a ChatGPT project
  means each person has a ChatGPT account (a free one is enough, with up to
  five collaborators on the free plan). Claude shares projects on Team and
  Enterprise plans; on the other plans a chat can be shared with specific
  people, view-only. Here a family member messages a Telegram contact, or
  signs in to your machine for web chat, and needs no account with an AI
  company.
- **It runs on a machine you own, with your data on it.** Claude Cowork's
  scheduled tasks run on Anthropic's side, or on your computer while its
  desktop app is open when they need your files. A Hatchabot agent's memory,
  files, credentials and history are on your disk, in plain files you can
  read, back up and move.
- **One AI source for a household's agents, with the cost of each.** Every
  agent in the house runs on the source you connect, and you see what each
  one spends and can cap it. A chat-app plan is per person, or per seat.
- **A scheduled job does not have to be a model run.** A scheduled task in
  the chat apps is the assistant doing the task again each time. Here a task
  can be a plain command in the agent's container, with the model called
  only where judgement is needed (see the case study below).
- **Agents that consult each other, and a supervisor over all of them.**
  Consultation between your own long-lived agents is not something an
  ordinary subscriber could set up in either app when last checked
  (September 2026), and the model per agent is chosen with the evidence
  and the saving shown. ChatGPT's Auto picks a model per message inside
  OpenAI's app; Claude's apps have you pick (checked early October 2026).

If you are the only one using it, the chat app is the better deal. These
points matter once there are several jobs, several people, and things you
would rather keep at home.

## Case study: use the model as little as possible

A household's meeting-and-voting agent schedules meetings by email and runs
board votes: people reply in their own words, it finds a time, sends the
invitations and counts the votes.

**Before.** It was an always-on AI agent: every check of its inbox, every
reply read and every decision was a model turn. At API list prices it cost
about **$1,700 a month**, and the QA agent that ran 49 regression cases
against it about **$990** more. It ran on a Claude plan, so that was room in
the plan's limits rather than a bill, but it was room the rest of the
household's agents needed.

**After.** It was rewritten as a small program that runs inside an ordinary
Hatchabot agent. Python makes every decision: parsing, scheduling, counting,
sending, keeping records. A small model (Claude Haiku) is asked only where
judgement on free-form email is needed, through the agent's own AI source,
so no API key was added. A scheduled command runs the program every minute;
a quiet minute costs nothing, because no model turn is involved.

**Result.** Cents a month instead of about $2,700 at API prices. The same
email gets the same answer. And it is tested: 117 unit tests, including the
49 cases the QA agent used to run, a check of its prompts against the real
model, and a scripted live test against the real mailbox and calendar.

**The principle:** decisions belong in code, and the model is used as little
as possible, only where it is needed. The agent gives the program a home: a
container, the owner's connections, an AI source, Telegram for notices, and a
chat that can run the program's commands.

**New in 2.144.0:** such a program deploys into an agent from its repository
(`hatchabot app install`, `update`, `rollback`), with its own tests run
inside the agent before anything switches (docs/apps-in-agents.md). The web
app's side of it (From a repo, an Update button) comes next.

## Who it's for

Someone who wants **more than one assistant** — a kitchen helper, a homework
tutor, a condo-board secretary, a stock-watching agent, a scheduler that reads
its own inbox — **shared with a household**, running on **their own machine**,
with **their own choice of AI**, and the confidence that what those agents learn
is durable, inspectable and portable.
