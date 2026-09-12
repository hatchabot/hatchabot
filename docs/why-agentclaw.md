# Why AgentClaw — philosophy and what it actually does

## The idea in one paragraph

Claude and ChatGPT give you **one assistant, in one app, from one company, for
one person, whose memory of you is whatever that company decides to keep.**
AgentClaw is the opposite shape: **many purpose-built agents, on hardware you
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

**Not locked to one lab.** Anthropic (subscription or API key), Google Gemini,
or a local model server with no account at all — per agent, switchable live
without a rebuild. Put simple agents on a cheap model and the demanding ones on
the best; group them into classes and retune a whole tier in one place. Your
agents outlive any one provider's pricing decision.

**The front door is Telegram.** No app to install for the people you invite, no
account with anyone but Telegram. Chat with an agent like a contact. Several
people can talk to the same agent — each privately ("blind" to each other) or
together in a group room — and the agent's memory can be shared across them or
kept personal, with everyone told which.

**Isolation by construction.** One container, one bot, one set of credentials
per agent. An agent can be given exactly the data it needs (a folder, a git
repo, a Google account — with "read mail but never send" if you like) and
nothing else. The security posture check tells you, every day, which agents
have both a wide audience and a powerful capability.

**Every operation is reversible or honest about not being.** Snapshots before
edits and rebuilds, rollback on a failed move, a full audit timeline of what
happened to which agent, usage reported as tokens rather than a made-up bill,
and health probes that distinguish "listed as running" from "actually
answering".

## What you can do that you can't do with a chat app

| Capability | What it means in practice |
|---|---|
| **Create agents fast** | Name + one paragraph + a bot token → a running, remembering agent in a minute. Clone one you like; import a shared template. |
| **Talk through Telegram** | You and your family message agents like contacts. Invite by link or QR; group rooms; per-agent allowlists. |
| **Many humans, one agent** | Private one-to-one threads with the same agent, or a shared room. Shared or private memory, declared. |
| **Choose the brain per agent** | Claude, Gemini, or a local model; switch the model live; classes for tiers; live source migration. |
| **Give agents accounts and data** | Gmail / Calendar / Drive / Sheets connections, folders, git repos it commits to, per-agent secrets. |
| **Schedule and react** | Cron tasks, event-triggered tasks (a zero-cost check decides whether to wake the model), run-now tests. |
| **Agents that consult each other** | Grant an investing agent access to your tax and legal agents; it asks them mid-task. |
| **Master → child lineage** | A "master" agent's improvements distil into proposals that push to its children. |
| **Move, copy, share, back up** | Rehost to another server in one step; download to a file; share as a template with no secrets; scheduled backups. |
| **Rebuild without fear** | Rebuilds keep memory; only a change of AI *source* resets a thread — and that offers to save memory first. |
| **Multiple machines** | Add runners (a laptop, a second box) and place agents where they fit. |
| **See what's going on** | Fleet health, usage per agent per day, audit timeline, security posture with daily diffs. |

## Who it's for

Someone who wants **more than one assistant** — a kitchen helper, a homework
tutor, a condo-board secretary, a stock-watching agent, a scheduler that reads
its own inbox — **shared with a household**, running on **their own machine**,
with **their own choice of AI**, and the confidence that what those agents learn
is durable, inspectable and portable.
