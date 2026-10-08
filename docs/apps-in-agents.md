# Apps in agents: deploy a codebase into a Hatchabot agent

*Status: phase 1 (server + CLI) shipped in 2.144.0 and phase 2 (the web app) in 2.145.0, 2026-10-07. Phase 2: the web app's
"New agent → From a repo" and an agent's App section with Update. Phase 3:
sharing (a template that carries the manifest).*

Some agents are mostly a program: a loop that reads mail, keeps records and
sends replies, with a model only where judgement on free-form input is needed.
Meeting Scheduler is the first: rewritten from an AI agent that ran at about $1,700
a month at API prices (about $2,700 with its QA agent) into a Python program that costs cents, it runs
inside an ordinary Hatchabot agent as a scheduled command. This is how any such
codebase gets deployed, updated and rolled back from Hatchabot.

## The idea

- **The code is the app; the agent is its home.** The agent's container gives
  it a place to run, its owner's connections (Google), its AI source (so a
  Claude subscription works, no API key), Telegram for notices, and a chat that
  can run the app's commands for its owner.
- **Use the model as little as possible.** Decisions live in code. Where the app
  needs judgement on free-form input it calls
  `openclaw infer model run --agent <id> --local --model … --json --prompt …`
  inside the container: one call, none of the agent's instructions loaded,
  billed to the agent's AI source. Not a ban; a budget.
- **No AI turn in the loop.** The app's loop is an OpenClaw *command* task: a
  plain command on a schedule (`openclaw cron add --command-argv …`). Idle
  minutes cost nothing.

## The manifest: `hatchabot.json` at the repo root

```json
{
  "app": "meetingscheduler",
  "name": "Meeting Scheduler",
  "description": "Schedules meetings and runs board votes by email.",
  "model": "claude-haiku-4-5",
  "chat": "You are the owner's control panel for {name}. Run `cd {app_dir} && {env} python3 -m msched status` …",
  "test": ["python3", "-m", "unittest", "discover", "-s", "tests"],
  "env": { "MSCHED_HOME": "{data_dir}" },
  "tasks": [
    { "name": "tick", "every": "1m", "command": ["python3", "-m", "msched", "tick"], "timeoutSeconds": 300 }
  ],
  "config": {
    "file": "config.json",
    "fields": [
      { "key": "mailbox", "label": "The app's email address", "type": "email", "required": true },
      { "key": "mode", "label": "off, shadow, pilot or live", "default": "shadow" },
      { "key": "openclaw_agent", "from": "agent.openclawId" },
      { "key": "telegram_account", "from": "agent.telegramAccount" },
      { "key": "owner_telegram", "from": "owner.telegram" },
      { "key": "timezone", "from": "host.timezone" }
    ]
  },
  "connections": [{ "kind": "google", "purpose": "the app's mailbox", "field": "mailbox" }]
}
```

- `app`: a short id (`[a-z0-9-]`), the folder name inside the agent.
- `test`: run inside the agent against the new release before it goes live,
  with `{data_dir}` set to a staging folder that holds only the new config
  (never the live data); a failure stops the install or update and leaves the
  running version and its config alone.
- `tasks`: OpenClaw command tasks, named `<app>-<name>`, re-synced on every
  install, update and rollback. `every` (`1m`, `15m`, `1h`) or `cron`.
- `env`, `command`, `chat`: placeholders `{app_dir}` (the live release),
  `{data_dir}`, `{agent}` (the OpenClaw agent id), `{name}`, `{env}` (the env
  as `K=V …`).
- `config.fields`: written to `{data_dir}/<file>` as JSON. A field is asked for
  (`required`, `default`) or filled by Hatchabot (`from`). Values already in the
  file are kept on update; new fields get their defaults.
- `connections`: what to attach before it runs; `field` names the config value
  that says which account (here the mailbox's Google login).

## Inside the agent

```
~/.openclaw/apps/<app>/
  releases/<sha>/     one folder per installed commit (the last 3 are kept)
  current -> releases/<sha>
  data/               config.json, the app's database: never touched by updates
  staging/<sha>/      the new config while its tests run (gone after)
```

## Install, update, roll back

1. Hatchabot reads the source **on the host** (only the machine's owner can do
   this; it uses the host's paths and git credentials): a local repo folder
   (`~/meetingscheduler`) or a git URL (cloned into
   `~/hatchabot-data/app-sources/`). It resolves the ref (default `HEAD`) to a
   commit and reads `hatchabot.json` from that commit.
2. It copies `git archive <sha>` into `releases/<sha>` on the agent's volume.
3. It stages the new config (asked + filled values, keeping existing ones) in
   `staging/<sha>/`; the live `data/config.json` is not touched yet.
4. It runs `test` in the new release, with the app's env and `{data_dir}` at
   the staging folder. Fails: stop here; nothing live has changed.
5. It switches: the staged config into `data/` (the old file kept aside), then
   `current` at the new release (atomically).
6. It re-syncs the tasks: the new ones are added first, then the old ones
   taken off.
7. It records the app, source, commit and previous commit for the agent.

A failure in step 5 or 6 puts everything back: `current` at the previous
release, its config to the byte (or no config, on a first install), and its
tasks (new ones taken off, old ones already removed re-added from the previous
release's `hatchabot.json`). The record is only written after step 6, so the
agent, its tasks and the record agree either way; the error says if anything
could not be put back. Replacing one app with another takes the old app's tasks
off first and puts them back if the new one fails.

**One copy per account.** An install is refused (409) when another live agent
already runs the same app on the account its values name (the mailbox): two
copies would both answer every email. The dialog warns first; `allowShared`
(the dialog's confirmation) overrides it.

**Update** is the same from step 1 with a newer commit; **rollback** points
`current` back at the previous release and re-syncs its tasks (if they cannot
be scheduled, it stays on the release it had).

## Commands

```
hatchabot app inspect <dir|url> [--ref <ref>]      the manifest and what it will ask
hatchabot app install <agent> <dir|url> [--ref <ref>] [key=value …]
hatchabot app create <name> <dir|url> [--profile <source>] [key=value …] [--no-telegram]
hatchabot app update <agent> [--ref <ref>]
hatchabot app rollback <agent>
hatchabot app status <agent>
```

API: `POST /v1/apps/inspect`, `GET|POST|DELETE /v1/agents/:id/app`,
`POST /v1/agents/:id/app/update`, `POST /v1/agents/:id/app/rollback`.

## In the web app

- **New agent → "run an app from a repo"** (the machine's owner): give the
  folder or git address, read it, pick the Google account it needs (the
  mailbox follows the account), fill in what it asks for, Create. The account
  is attached before the agent first runs. The agent
  is made with the app's name, chat and model, and Hatchabot installs the app
  as soon as the agent is running (`POST /v1/agents/:id/app/pending`, run when
  provisioning finishes), so closing the browser does not lose it.
- **The agent's page → App**: which app, which commit, from where, and whether
  its tests passed, with **⬆ Update** (the newest commit; its tests run first
  and the running version stays if they fail, with their output shown),
  **↩ Roll back** and **Stop app**. An agent without one offers "Run an app
  from a repo…". A failed install from a new agent shows why, with Try again.

## Writing an app for this (what to tell Claude Code)

Give the codebase's Claude Code session this, adjusted:

> Make this codebase deployable as a Hatchabot app (see ~/hatchabot/docs/apps-in-agents.md):
> it runs headless inside the agent container (Debian, Python 3.11, Node 22),
> standard library or vendored dependencies; decisions in code, and the model
> only where judgement on free-form input is needed, through
> `openclaw infer model run --agent {agent} --local` with validated fixed-shape
> output; a CLI with a `tick`-style command run every minute by a command task,
> with a lock so runs never overlap; config and data in `$APP_DATA` (never the
> repo); owner notices through `openclaw message send`; modes off / shadow /
> pilot / live; unit tests with fakes, a prompt check against the real model,
> and a live end-to-end script for pilot mode; AGENTS.md and a knowledge pack;
> and a `hatchabot.json` manifest.
