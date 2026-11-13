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
fraction of the cost. **A browsing task is expensive.** The model uses the
browser tool many times in one task, and each of those calls sends the
whole conversation so far, page reads included. Measured on a test agent
(2026-11-12, OpenClaw 2026.9.8, each task once per kind of read):

| Task | Default reads | "Efficient" reads |
| --- | --- | --- |
| Read one page | 1.3 million tokens, 30 model calls | 0.34 million, 13 calls |
| Fill in a form and submit it | 3.5 million, 63 calls: not done in 10 minutes | 2.5 million, 50 calls |
| Follow a link and read | 1.8 million, 41 calls | 3.0 million, 61 calls: not done in 10 minutes |

About 96% of those tokens are the conversation read again from the prompt
cache; a call averaged 26,000 to 55,000 tokens, depending on the task.

A page read is up to 40,000 characters (about 10,000 tokens), cut off there.
OpenClaw has a smaller "efficient" read (8,000 characters at most), which
Hatchabot does not make the default: it keeps only what can be clicked or
typed into, near the top of the page's structure. On five test pages
(2026-11-11) it dropped all of an article's text, and on a form it kept the
text boxes and the button but lost the radio buttons and checkboxes. With a
model driving (the table above) it saved no clear amount: 89% of the
default's tokens over the three tasks, much less on one, much more on
another, and each kind of read left one task undone. The agent can still
ask for it, read by read.

`node scripts/browser-cost.mjs` measures it again on a test agent: the three
tasks, each with both kinds of read, the tokens of each turn and whether the
task was done. It spends real AI turns (six by default) on the default AI
source; `--only` and `--modes` run part of it.

## Sign in to a site

Some sites the agent must use want a sign-in. **Sign in to a site** shows
you the agent's browser, live, so you sign it in yourself: agent page →
**Advanced** → **Browser** → **Sign in to a site…** (the agent running,
its browser on). Type an address, then click and type in the page as in
any browser:

- **On a computer:** click a box in the page and type straight into it.
  Enter, Backspace, Tab and the arrows work; so does pasting.
- **On a phone:** tap a box in the page, then type in the box under the
  picture and press **Send**; **Enter ↵** presses Enter in the page. A
  finger dragged on the picture scrolls the page. What you type there is
  hidden as you type (**Show** shows it).

Also for what the agent gets stuck on: a two-step code, a cookie banner, a
CAPTCHA. Then tell the agent to carry on: it opens the site in its own tab,
signed in.

**How long it lasts:** until the agent restarts (a restart, a sleep, a
rebuild, a stop). The browser's profile lives in memory: nothing it is
signed in to is kept on disk, in backups or in downloads.

**What it means:** while it is signed in, the agent can act as you on that
site, and so can a page that tricks it or anyone who can message it. It can
also copy the sign-in out of its browser, and see what you type in the
panel. Sign it in only where you would let it act for you: never your
email, bank or password manager, nor the Google account behind its
connections. Where a site allows it, give the agent an account of its own.

**What will not work:** passkeys and security keys (a headless browser has
no authenticator), and sites that refuse automated browsers: the browser
tells every site it is `HeadlessChrome`, and some large sign-in providers
turn it away. Two-step codes work: you type them.

**How it is held:**

- The agent's owner only: not other members, web chat guests or the
  manager. At the public address it asks for your second factor again.
- Only over an encrypted connection: this Hatchabot's https address, a
  device on your tailnet, or the machine itself. Over plain http on your
  network it stays shut, because what you type in it is a password.
- The panel reaches the browser through the Docker connection Hatchabot
  already has to the agent's machine (a runner's too): a small relay in the
  agent's container, on a tab of its own. Nothing is published or opened.
- The app's page sends only clicks, scrolls, text, a few keys and
  addresses (http and https). Hatchabot turns them into the browser's
  commands from a fixed list, and the relay refuses any other: nothing on
  it reads cookies or storage or runs a script. Pictures, the address and
  whether it is loading come back; the rest of what the tab says does not.
- What you type is not stored or logged. The agent's timeline says when the
  panel was opened and closed, nothing more.
- The fence holds: a private address does not open in the panel either.
- One panel per agent: opening it again (another tab, your phone) closes
  the first. It closes after ten minutes with nothing clicked or typed;
  the browser keeps the page.

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
  - and a page cannot send it there by itself. OpenClaw checks page loads
    only while the agent is acting on a page; a page whose own timer moved
    it to a LAN address afterwards reached that address (2026-11-12). So
    Chromium runs as a user of its own, and before it starts Hatchabot sets
    a firewall rule in the network it shares with the agent: that user
    cannot open a connection to a private address (loopback, the LAN, the
    tailnet, link-local). The agent itself keeps its reach (a model on your
    LAN, say). Where the rule cannot be set, the browser does not start;
    see the troubleshooting entry "browser fence failed";
  - tabs it leaves idle for two hours are closed, and a conversation keeps
    at most eight (OpenClaw's `browser.tabCleanup`: on by default, and
    Hatchabot sets it on; OpenClaw 2026.9.8 has no setting for the times).
- **Memory goes with open tabs, not with the browser.** Measured 2026-11-11
  (Chromium 154): just started, 160 MB; eleven ordinary pages open, the whole
  1 GB; those tabs closed, 250 MB. So it is not stopped while idle. At
  its limit it slows rather than fails: with sixteen pages open it stayed
  at the limit, nothing was killed, and the page in use read normally
  (Chromium 156, 2026-11-12). In real use tabs did not pile up: after
  three browsing conversations, two tabs were open and the browser held
  510 MB.
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
  build their own. It holds the Chromium Debian had that day. A release
  whose image file is new (its refresh date is moved at least every 14
  days) has each machine build again within a minute of upgrading, so the
  Chromium stays current; the image it replaces is removed. `hatchabot
  browser "<agent>"` and the agent's Advanced tab say which Chromium is
  running. A build that fails is tried again after a minute, then
  after twice as long each time (up to an hour): the Setup log says "its
  browser did not start" once per try, with the build's error.
- If you switch it while a rebuild is already under way, the switch is saved
  and you are told it may not be applied: rebuild the agent once that rebuild
  ends.
- Removing a runner (Settings → Hosts) removes its browsers there too.

## Checking it

- `hatchabot browser "<agent>"` — on or off, running or not, and its Chromium.
- `hatchabot doctor` — the Chromium the agents' browsers run on this
  machine; it warns when one still runs an older image, or when the image
  is over 30 days old (upgrade for a current Chromium).
- In the agent: `openclaw browser status --json` shows the `hatchabot` profile
  attached; `openclaw browser open <url>` then `openclaw browser snapshot`
  reads a page without the model.
- The live test `browser` (docs/live-tests.md) does both, and checks the
  isolation, that scripts and private addresses are refused, that a page
  sending itself to one later does not reach it, and that the sign-in panel
  signs it in to a demo login page, on a test agent.
