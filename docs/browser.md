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

A page read is up to 40,000 characters (about 10,000 tokens), cut off there.
OpenClaw has a smaller "efficient" read (8,000 characters at most), which
Hatchabot does not make the default: it keeps only what can be clicked or
typed into, near the top of the page's structure. On five test pages
(2026-11-11) it dropped all of an article's text, and on a form it kept the
text boxes and the button but lost the radio buttons and checkboxes. The
agent can still ask for it, read by read.

## How it works

- Each agent with the browser on gets **its own Chromium**, in a container
  beside the agent's. It shares only the agent's network (so the agent reaches
  it at `127.0.0.1:9222` and nothing else can), not its files.
- It has a memory limit of its own (1 GB; `HATCHABOT_BROWSER_MEMORY`). A
  change reaches running browsers at the next sweep, which replaces them.
  Agents without the browser run none, and their browser tool is switched off.
- Its profile lives in memory: **nothing it logs into is kept** across a
  restart of the agent. It starts with no cookies and no saved logins.
- **What a page can make of it is held to the least** (set at every build of
  the agent):
  - the agent cannot run its own scripts in a page (OpenClaw's
    `browser.evaluateEnabled` is off; it is on by default there). It reads,
    clicks, types and fills in forms;
  - it does not open private addresses: your LAN, this machine, its own
    control port. That is OpenClaw's own rule when `browser.ssrfPolicy` is
    left unset, as Hatchabot leaves it. Do not set it by hand: with it
    written, OpenClaw 2026.9.8 refuses every address that is a name
    ("strict browser SSRF policy requires an IP-literal URL");
  - tabs it leaves idle are closed (`browser.tabCleanup`).
- **Memory goes with open tabs, not with the browser.** Measured 2026-11-11
  (Chromium 154): just started, 160 MB; eleven ordinary pages open, the whole
  1 GB; those tabs closed, 250 MB. So it is not stopped while idle.
- It runs headless, with Chromium's own sandbox off (normal inside a
  container); the container is the boundary: no extra privileges, a read-only
  system, nothing of the agent's mounted.
- A sweep every minute keeps the browsers in step with the agents: it starts
  one for an agent that has it on and is running, replaces it when the agent
  restarts (a new network), and removes it when the agent stops, sleeps, is
  switched off, archived or deleted. One sweep at a time per machine; it
  touches only this install's browsers (labelled with its `HATCHABOT_PREFIX`),
  never another Hatchabot's on the same Docker.
- Its image (`hatchabot-browser:<hash>`, Chromium on Debian) is built on that
  machine the first time an agent there needs it (a minute or two); runners
  build their own. A build that fails is tried again after a minute, then
  after twice as long each time (up to an hour): the Setup log says "its
  browser did not start" once per try, with the build's error.
- If you switch it while a rebuild is already under way, the switch is saved
  and you are told it may not be applied: rebuild the agent once that rebuild
  ends.
- Removing a runner (Settings → Hosts) removes its browsers there too.

## Checking it

- `hatchabot browser "<agent>"` — on or off, running or not.
- In the agent: `openclaw browser status --json` shows the `hatchabot` profile
  attached; `openclaw browser open <url>` then `openclaw browser snapshot`
  reads a page without the model.
- The live test `browser` (docs/live-tests.md) does both, and checks the
  isolation and that scripts and private addresses are refused, on a test
  agent.
