# An agent's own browser

OpenClaw has a browser tool: an agent can open web pages, read them, click,
type and fill in forms. Hatchabot gives an agent a browser for it **only when
you switch it on** for that agent: agent page → **Advanced** → **Browser**, or

```sh
hatchabot browser "<agent>" on      # off to take it away; no argument: its state
```

Switching rebuilds the agent (a minute or two); its browser starts within a
minute of it coming back.

## When to use it

For sites the agent has to *use*: a form to fill, a page behind a click, a
site without an API. Not for looking things up: web search does that for a
fraction of the cost. A browsing question is expensive: each page reaches the
model as a large outline of the page, often several times per answer. In the
first trial one question took 315,000 tokens (2026-10-08).

## How it works

- Each agent with the browser on gets **its own Chromium**, in a container
  beside the agent's. It shares only the agent's network (so the agent reaches
  it at `127.0.0.1:9222` and nothing else can), not its files.
- It has a memory limit of its own (1 GB; `HATCHABOT_BROWSER_MEMORY`). Agents
  without the browser run none, and their browser tool is switched off.
- Its profile lives in memory: **nothing it logs into is kept** across a
  restart of the agent. It starts with no cookies and no saved logins.
- It runs headless, with Chromium's own sandbox off (normal inside a
  container); the container is the boundary: no extra privileges, a read-only
  system, nothing of the agent's mounted.
- A sweep every minute keeps the browsers in step with the agents: it starts
  one for an agent that has it on and is running, replaces it when the agent
  restarts (a new network), and removes it when the agent stops, sleeps, is
  switched off, archived or deleted.
- Its image (`hatchabot-browser:<hash>`, Chromium on Debian) is built on that
  machine the first time an agent there needs it (a minute or two); runners
  build their own.

## Checking it

- `hatchabot browser "<agent>"` — on or off, running or not.
- In the agent: `openclaw browser status --json` shows the `hatchabot` profile
  attached; `openclaw browser open <url>` then `openclaw browser snapshot`
  reads a page without the model.
- The live test `browser` (docs/live-tests.md) does both, and checks the
  isolation, on a test agent.
