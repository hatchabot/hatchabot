# Hatchabot — the pitch

## Your AI should be your own staff, not a search box.

You already pay for a brilliant model. It remembers you, runs tasks on a
schedule and reads your Drive — for one person, inside one app. Both Claude and
ChatGPT now let you view, edit and export what they remember. The difference is
where it lives and who uses it: a Hatchabot agent's memory is a plain file on
your disk that the agent reads directly. You can back it up with everything
else, run it under another model, or move it to another machine, without
anyone's export button.

**Hatchabot turns that subscription into a household of agents you own.** Each
one has a job, a personality, and a memory that grows for years. Each one lives
behind a Telegram bot, so your family talks to them like contacts — no app to
install, no accounts to create. And they all run on a computer in your house.

## Three problems it solves

**1. "I keep re-explaining myself."**
Agents remember. Facts, decisions, preferences — written to memory files you can
read and edit. Tell Hatchabot once who you are and every agent you create
already knows.

**2. "One assistant can't be good at everything."**
Make one per job in a minute: a kitchen helper on a cheap model, a tax advisor
on the best one, a scheduler that polls its own inbox and books meetings. Let
them consult each other. Clone the good ones. Share a trained one with a friend
— minus your secrets.

**3. "I don't want to be locked in."**
Claude, Gemini or a local model, per agent. Switch models within a source
instantly; switching providers takes a rebuild and starts a fresh conversation,
with memory kept.
Your agents are files and containers on your hardware. Move them to another
machine in one click. Back them up. Nothing about them belongs to a provider.

## What makes it different

- **Telegram as the front door** — the one app everyone already has; Slack, Discord and the web app work too. Invite by link or QR.
- **Many people, one agent** — talk to it directly, share it with several people, or put it in a group room; it keeps one memory for everyone and one conversation for direct messages, and says so.
- **Real capabilities, real limits** — a Google account whose mail tool has sending switched off (a tool setting, not a Google permission — don't rely on it against someone determined); a folder but read-only; a git repo where every change is a commit.
- **Runs at home** — your data stays on your machine. Put one on a local model and your conversations never go to an AI company. The agent still uses the internet for search and tools, and chat apps carry messages through their own servers.
- **What each agent costs, and a cap if you want one** — a weekly cost on every tile at API prices, what it went on and which model, and a monthly budget per agent or for the whole machine: warned at 80% and 100%, and at the limit a cheaper model or a pause until the 1st.
- **A supervisor for the models** — your Hatchabot agent keeps each agent on the least capable model that does its job, catches loops and oversized conversations, and shows what the switches saved. You confirm every change.
- **Operator-grade tooling** — rebuilds that keep memory, snapshots before every edit, one-click recovery of lost context, a tab per agent's console, a daily security posture check, an audit trail of everything.
- **Help from its own code** — your Hatchabot agent checks a playbook of known problems and reads the code of the release you run; Report a problem files a GitHub issue with your private details masked, and you submit it.
- **Open source, one command to install** — Docker is the only prerequisite on Ubuntu, Debian and Apple-silicon Macs; one line fetches the current stable release, and the install ends with a link and a QR code for your phone.

## Use the model as little as possible

A household's meeting-and-voting agent, which schedules meetings and runs
board votes by email, cost about $1,700 a month at API prices as an always-on
AI agent, plus about $990 for the QA agent that tested it. It was rewritten as
a small program running inside a Hatchabot agent: Python makes every
decision, and a small model (Claude Haiku) is asked only where judgement on
free-form email is needed, through the agent's own AI source. It now costs
cents a month, gives the same answer to the same email, and is tested: 117
unit tests (the old QA agent's 49 cases among them), a prompt check against
the real model, and a scripted live test against the real mailbox and
calendar. Decisions in code; the model only where it is needed. Since 2.144.0 such a
program deploys into an agent from its repository, with its tests run inside
the agent first, and updates or rolls back with one command
(docs/apps-in-agents.md).

## Who it's for

Technically comfortable households and small teams who want more than a
chatbot: a set of agents with jobs, shared with the people who need them, on
hardware and terms they control.

## Try it in 15 minutes

Install Telegram, get a Claude subscription, run the setup script, paste one
token, tap **+**, say hi. Your first agent is answering — and it will still
remember what matters from this conversation next year.

*→ docs/quickstart.md*
