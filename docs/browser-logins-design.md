# Saved logins and "Sign in yourself" for an agent's browser (design)

Status: a design for the owner to approve (HB-0680, 2026-11-12), checked
by a trial in throwaway containers on 2026-11-13 (below, "The trial").
Nothing of it is built. The agent's own browser is described in
docs/browser.md.

Today an agent's browser keeps nothing: its profile is in memory, so a
restart of the agent forgets every site it was signed in to, and nobody can
sign in to a site in it except the agent itself, with a password someone
gave it. This note adds two things:

1. **Sign in yourself:** a live view of the agent's browser in the app,
   where you click and type yourself: sign in, type a two-step code, accept
   a cookie banner, solve a CAPTCHA. Then the agent carries on.
2. **Keep its logins:** an opt-in switch that keeps the browser's profile
   on disk, so those sign-ins survive restarts, until you forget them.

## The risk, plainly

What a signed-in browser means has to come first, because nothing below
makes it safe; it only makes it your choice.

- **The agent can act as you on that site.** So can anything that steers
  the agent: a page it reads that tells it what to do (prompt injection),
  or a message from anyone else who can talk to it.
- **The agent can also copy the sign-in out.** Every process in the agent's
  container reaches the browser's control port (that is how OpenClaw drives
  it), and that port gives full control with no password: cookies, scripts,
  everything. Hatchabot's `browser.evaluateEnabled` off closes OpenClaw's
  tool, not the port. So a tricked agent can send a session to someone else,
  and forgetting it here does not sign it out there. This cannot be split by
  user: the agent's gateway and its shell commands run as the same user.
- **On disk the profile is as good as plain text.** Chromium on Linux with
  no keyring (a container has none) encrypts cookies with a fixed key.
- **What stays as it is:** the fence (the browser opens no private address,
  signed in or not), scripts off, one browser and one profile per agent.

So the design's job is to make a signed-in agent a deliberate choice of
the agent's owner, per agent and per site, that is easy to see and easy to
undo. The advice to the owner stays simple: sign it in only where you
would let it act for you; never your email, bank or password manager, nor
the Google account behind its connections; where a site allows, give the
agent its own account.

## 1. Sign in yourself (the live view)

**In the app:** agent page → **Advanced** → **Browser** → **Sign in to a
site**. A panel shows the browser's page live, with an address box, back
and forward. You click, scroll and type in it as in a browser; on a phone,
taps and the phone's keyboard. Closing the panel closes its tab; the
sign-in stays in the browser.

**How it works:**

```
the app's page  ⇄  Hatchabot (WebSocket, the owner's session)
                ⇄  docker exec -i <agent container>: a small relay in Node
                ⇄  the browser's control port, 127.0.0.1:9222, inside the agent's network
```

- Chromium's own screencast sends pictures of the page (JPEG, sized to the
  panel, one at a time as the app takes them); clicks and keys go back as
  input events. It works headless; nothing like VNC is added.
- The relay runs through the same Docker connection Hatchabot already has
  to the agent's machine, so an agent on a runner works the same way.
  Nothing new is opened: no port is published, and the control port stays
  inside the agent's network.
- Not chosen: publishing the control port on the machine. It has no
  password, so anything on the machine (on a shared host, another tenant)
  could take over the signed-in browser. Also not chosen: OpenClaw's own
  browser commands (screenshot, click at a point, type): slow, and what you
  type would pass through the agent's gateway and maybe its logs.
- **Hatchabot passes on only a fixed list of the control port's commands
  from the panel:** the screencast, mouse, keys and text, open an address,
  back and forward, and the page size. Never those that read cookies or
  storage or run scripts. So even a fault in the app's page cannot read
  the browser's sign-ins through the panel.
- One panel per agent at a time, in a tab of its own. It closes after ten
  minutes with no input.
- What you type is not stored or logged by Hatchabot. The panel opens only
  over an encrypted connection: HTTPS, the tailnet, or this machine itself.
  Over plain HTTP on the LAN it says why and stays shut, because what you
  type in it is a password.
- The fence applies: a private address does not open in the panel either.

**Without "Keep its logins"** a sign-in lasts until the agent restarts.
That is still worth having alone: a sign-in for one job, a cookie banner
or a CAPTCHA the agent is stuck on.

**What will not work:** passkeys and security keys (a headless browser has
no authenticator); sites that refuse automated browsers, which some large
sign-in providers do. The browser names itself `HeadlessChrome` to every
site, so a site can tell. Two-step codes work: you type them.

## 2. Keep its logins

**The switch:** under Browser, **Keep its logins**, off by default, only
with the browser on. Switching it on asks first (the text is in section 4).

**How:** a Docker volume per agent, `<agent container>-browser-profile`,
labelled as this install's, mounted at `/profile` in place of the memory
profile. A volume alone is not enough; the trial found three things it
needs:

- **Made the browser's user's when it is created.** A new volume belongs
  to root, and Chromium (user 1001) does not start on it. A throwaway
  container with only the right to change owners sets it, as the fence's
  does for the firewall.
- **"Continue where you left off" set in the profile**
  (`session.restore_on_startup` 1 in its Preferences). Without it Chromium
  drops session cookies every time it ends, and a session cookie is how
  most sites keep you signed in unless you tick "remember me". With it, a
  sign-in survived; without it, only a cookie with an expiry date did. A
  side effect: the tabs open when it ended open again, and tab cleanup
  closes them after two hours idle.
- **Closed, not stopped.** `docker stop` ends Chromium in a tenth of a
  second without writing its profile, `--init` or not. Everything from
  the last half minute was lost, sign-ins included. Closed over its
  DevTools port (`Browser.close`), it writes the profile and exits in
  about two seconds. So every end of a browser that keeps logins closes
  it that way first: the sweep, and an agent's stop, sleep, restart and
  rebuild, before the agent's container goes (the browser lives in the
  agent's network, so its port goes with it). An end nobody chose (power
  lost) loses what changed in the last 30 seconds or so: Chromium writes
  its cookies out about that often, and a cookie set 35 seconds before a
  `docker stop` was kept.

After a dozen pages the volume held 31 MB, page cache included, so the
cache stays where it is. The sweep warns when one passes 500 MB.

**Forget logins:** a button beside the switch, and
`hatchabot browser "<agent>" forget`. The browser is removed with its
volume, and the next one starts empty. Switching the setting off forgets
too.

| What happens | Its logins |
| --- | --- |
| The agent restarts, sleeps and wakes, is rebuilt | kept |
| A release refreshes the browser image | kept (Chromium carries a profile forward; after a downgrade, forget) |
| The browser is switched off, or Keep its logins | removed |
| The agent moves to a runner or to another Hatchabot | not carried: sign in again there |
| The agent is archived or deleted; `uninstall --purge` | removed |
| Nightly backups, downloads, templates, clones | **not included** |

**Why not in backups and downloads:** a backup set is files anyone with
the disk can read, often on a NAS. The cookies in it are as good as plain
text, and a restore would bring back sign-ins you may have forgotten on
purpose. Signing in again takes a minute. The backup script leaves these
volumes out by their label, and does not report them as volumes no agent
uses.

**What the app shows:** Advanced → Browser says "Keeps logins" and lists
the sites you opened in the sign-in panel, newest first, with the day.
Alerts' line for the agent adds "keeps logins" beside "its own browser".

## 3. Who may do what

- **Open the panel, switch Keep its logins on, forget:** the agent's owner
  only, the same rule as the browser switch. Never a web chat guest or
  another member, and never the management chat: the routes are marked
  "app: browser" in the manager's coverage ledger, so it gets no tool for
  them. The CLI's `forget` uses the owner's own sign-in.
- **Others who can steer the agent:** people given web chat, a Telegram
  group it is in, its peer agents, its scheduled tasks. Each of them can
  ask a signed-in agent to act as you. The switch-on dialog names them.

## 4. Telling the owner

The dialog when Keep its logins goes on (draft):

> **Keep this agent's logins?**
> Sites you sign in to in its browser stay signed in until you forget
> them. While they are, the agent can act as you there, and so can a web
> page that tricks it, or anyone who can message it: *(the list)*. It can
> also copy the sign-in out of the browser. Sign it in only where you
> would let it act for you; never your email, bank or password manager.
> Logins are not in backups or downloads.
> **Keep logins** · Cancel

docs/browser.md gets a section with the same advice, and the
troubleshooting entries for a sign-in the panel cannot complete.

## Decisions for the owner

1. **Order.** (a) The panel first, in one release, where a sign-in lasts
   until a restart; Keep its logins in the next. (b) Both at once.
   Recommended: (a). The panel is useful alone, and it is where the
   unknowns are (the screencast, input on a phone, sites that refuse).
2. **Backups and downloads.** (a) Saved logins left out. (b) Included.
   Recommended: (a), for the reasons in section 2.
3. **An agent others can message.** (a) Keep its logins allowed, with
   those people and agents named in the dialog. (b) Refused while anyone
   but the owner can message it. Recommended: (a). A household may want a
   shared agent signed in to a shared account; the dialog makes it a
   choice, not a surprise.

## Not in this design

- Giving the agent a password in chat. It goes into the conversation and
  to the AI provider. It is possible today, and not recommended.
- Copying cookies from your own browser. OpenClaw's `import-profile` is for
  macOS and copies your everyday sessions.
- OpenClaw's Chrome extension, which drives your own Chrome on your
  computer. That computer has to be on and paired, so it is a different
  feature.
- Watching the agent work live: the same panel, view only, on the agent's
  tab. A small follow-up once the panel exists.
- Forgetting logins on a timer.

## The trial (2026-11-13)

Throwaway containers: the runtime image of OpenClaw 2026.9.8 as the agent,
the browser image of v2.182.0 (Chromium 156) beside it in its network,
with the fence set. A script on the machine played the app and the
person: it started the relay with `docker exec -i` and sent only the
commands on the panel's list. Where a field was on the page, and what the
page said, it read on the side, as a person reads the screen.

- **The panel works.** The screencast runs headless. A frame is 20 to 28
  KB at 1,000 × 700 (7 to 21 KB at phone size), and the next one arrived
  8 to 18 ms after a key. A public demo login page was signed in to with
  clicks, typing and Enter alone. At phone size a tap and typing worked
  the same way. The saved frames show what a person would have seen.
- **The agent carries on signed in.** After the panel's sign-in, the
  agent's own browser tool, in a tab of its own, opened the site's
  members-only page.
- **The list holds.** Commands that read cookies or storage, run a
  script, open a tab, take a screenshot or close the browser were each
  refused, and none reached the port. The panel's tab was gone when it
  closed.
- **A runner's connection works.** The same sign-in ran with the Docker
  CLI pointed at an `ssh://` host. A stand-in for `ssh` ran Docker's own
  `dial-stdio` on this machine, which is the path the CLI takes to a
  runner over ssh. A `tcp://` runner (TLS) was not tried: the CLI streams
  the same way over it.
- **Sign-in pages load.** GitHub's, Google's, Microsoft's and Amazon's
  sign-in pages each opened and showed their fields. Whether they refuse
  after a password needs a real account, so it is the owner's test by
  hand once the panel is built.
- **A kept profile needs the three things in section 2.** A plain volume:
  Chromium did not start. `docker stop` 5 seconds after a sign-in: nothing
  kept. Closed with `Browser.close`: cookies with an expiry date kept,
  the sign-in lost. With "continue where you left off" as well: the
  sign-in kept.

## Still to check once built

- **Tests:**
  - the relay's command list (a refused command never reaches the port);
  - owner-only routes, classified in `src/api/publicRoutes.ts` and the
    coverage ledger;
  - forget, archive, delete and move leave no volume behind;
  - the backup leaves the volume out;
  - a `test:ui` scenario for the panel at desktop and phone widths.
- **The `browser` live test:** a scripted sign-in through the panel's
  route on a public demo page, kept across an agent restart and a sleep
  with Keep its logins on, and gone after forget; the same through a
  runner.
- **By hand, the owner:** signing in to a few real sites they use, which
  the trial could not do without an account.

## Code it would touch

- `src/providers/localDockerProvider.ts` — `ensureBrowser` (the `/profile`
  mount) and a streaming exec for the relay; `src/orchestrator/browser.ts`
  — `browserSweep` (the volumes).
- `src/api/routes.ts` — `'/v1/agents/:id/browser'` (PATCH `keepLogins`),
  the panel's WebSocket, forget; `src/api/publicRoutes.ts`;
  `src/mgmt/coverage.ts`.
- `scripts/backup-volumes.sh`, `scripts/uninstall.sh` (`volumes`),
  `src/orchestrator/transfer.ts`, `src/orchestrator/moveHost.ts`,
  `src/orchestrator/archive.ts`: where the volume is left out or removed.
- `src/providers/localDockerProvider.ts` — `stopBrowser` and the agent's
  stop paths: `Browser.close` before the container goes, for a browser
  that keeps logins.
- `web/index.html` — `v2LoadBrowser` and the panel; `src/cli.ts`
  (`forget`); docs/browser.md, docs/troubleshooting.md.
