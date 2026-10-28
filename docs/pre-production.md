# Before this serves anyone you don't fully trust

Hatchabot currently runs as a **single-household installation**: every account
on it belongs to someone the operator trusts personally. Several decisions lean
on that. This file lists what must change before the software is exposed to
users the operator does *not* vouch for — a paying customer, a colleague, a
stranger with a link.

Each item says what is deliberately permitted today, why it is acceptable here,
and what "fixed" looks like. Items that have since been fixed stay listed, under
their old numbers (the code refers to them), with the release that fixed them.
The wider threat model for family members on one machine is in
[family-member-risk-assessment.md](family-member-risk-assessment.md).

*Checked against the code and `CHANGELOG.md` as of v2.170.0.*

| § | Item | Status |
|---|---|---|
| 1 | A shared machine-login Claude source mounts the owner's `~/.claude` | Fixed in v0.120.0; no new machine-login sources since v2.39.0 |
| 2 | Un-sharing an AI source does not revoke it | Fixed in v2.87.0 |
| 3 | The fleet media and search keys reach every account | **Open** |
| 4 | First sign-in claims the whole installation | Fixed for accounts mode (v1.10.0, v2.31.1); **open** for Google sign-in without an allowlist |
| 5 | Containers run without full capability restrictions | **Partly open** |
| 6 | Members can read more than they should | Fixed in v2.39.0 and v2.88.4 |
| 7 | Operational gaps that bite at scale | **Partly open** (one item) |
| 8 | Every DM member shares one conversation thread | **Open** (stated to members since v2.107.0) |
| 9 | Session resets in the chat lose the thread | **Partly closed** |
| 10 | Public access rests on its listener's trust rules | **Accepted risks**, listed |

---

## 1. FIXED — a shared machine-login Claude Max source mounted the owner's `~/.claude`

*Found in the 2026-08-27 audit; relaxed again on 2026-08-28 as an accepted
risk; closed in v0.120.0.*

A Claude Max AI source came in two flavours:

| Flavour | What it is | What sharing it grants |
|---|---|---|
| **Machine login** (no stored credential) | the profile owner's `~/.claude` **directory**, bind-mounted into the agent container | OAuth refresh token, every Claude Code transcript under `~/.claude/projects/`, and **write** access to `settings.json` — whose hooks execute as that owner |
| **Setup token** (`claude setup-token`) | a token in the SecretStore, injected as `CLAUDE_CODE_OAUTH_TOKEN` | the OAuth token only — no filesystem, no transcripts, no code execution |

**What is in the code now:**

- `buildRuntimeSpec` (`src/orchestrator/provision.ts`) mounts `claudeAuthDir()`
  only when `profile.ownerId === agent.ownerId`: the backstop.
- `PATCH /v1/ai-profiles/:id` refuses to mark a machine-login source shared.
- Creating an agent, switching its source, a class's source and the bulk
  switch all refuse a machine-login source for another account's agent.
- Since v2.39.0 no new machine-login source can be created (unless
  `HATCHABOT_ALLOW_MACHINE_LOGIN=1`): the mount is read-write even for the
  owner's own agents, so an agent talked into writing a hook into
  `settings.json` would run it as the owner. Existing ones keep working, and
  the Security check says to move them to a setup token.

**Still true:** a shared setup token or API key is injected into the other
account's containers, so its users can read it. Sharing it is *acceptable*,
not *safe*; the genuinely safe design is for Hatchabot to broker the calls and
never hand the credential over.

## 2. FIXED in v2.87.0 — un-sharing an AI profile did not revoke it

`buildRuntimeSpec` now re-checks at every build that the source is the agent
owner's or still shared, and refuses the build with "Its AI source is no longer
shared with you" otherwise. An agent already running on it keeps it until its
next rebuild or move (a build is the moment it moves); a refused rebuild keeps
the agent running as it was and says why. A source that other accounts'
agents still use cannot be deleted until they move; the machine owner's
**Migrate all off…** (`hatchabot migrate-source`) moves them onto a shared
source.

## 3. The fleet media and search keys reach every account

`MEDIA_KEY_REF` (`GEMINI_API_KEY`, for voice notes) and `SEARCH_KEY_REF`
(`BRAVE_API_KEY`, for web search) are injected into **every** agent container
regardless of owner (the management agent gets no search key), while the
routes that manage them are host-owner-only. Any account can read them out of
its own container. The Security check lists them as shared fleet keys. Fix:
scope them per owner, or treat them as explicitly shared house credentials
that the owner is told about when inviting someone.

## 4. First sign-in claims the whole installation

`store.adoptLocalOwnerData` re-keys every row the installation's password-mode
owner held — agents, sources, **hosts**, memberships, peers, tokens and the
rest — to the first real account.

- **Accounts mode (the installer's default): fixed.** Account #1 is made from
  the machine itself, or from elsewhere only with the setup code the server
  prints when it starts (v1.10.0, and over a tailnet v2.31.1). Rootless Docker
  and Docker Desktop hosts ask for the code even at localhost. The public
  address never allows it (§10).
- **Google sign-in (identity mode): still open unless an allowlist is set.**
  The first Google account to sign in inherits the installation *and* host
  ownership. `HATCHABOT_ALLOWED_EMAILS` limits sign-in to listed addresses, and
  since v2.103.0 the Security check shows a critical warning while it is unset;
  nothing requires it. Fix: refuse identity mode without an allowlist, or a
  one-time claim code as in accounts mode.

## 5. Containers run without full capability restrictions

Agent containers execute model-generated shell and Python. They run as
non-root (the main protection), with `--security-opt=no-new-privileges`
(v0.120.0), `--memory`, `--pids-limit`, `--init`, capped logs, and on their own
Docker network with inter-container traffic off (v1.16.0). The browser,
memory-search and door containers also drop every capability.

**Still missing for agents:** `--cap-drop=ALL` (an agent container keeps
Docker's default capabilities), a CPU limit (one agent can take every core),
and a disk quota (an agent can fill the disk; `scripts/agent-disk-check.mjs`
only warns). `HATCHABOT_MAX_AGENTS_PER_ACCOUNT` caps how many agents one
account can have. Fix: drop capabilities by default (with a compatibility
check), add `--cpus`, and a per-agent volume quota where the storage driver
allows one.

## 6. FIXED — members could read more than they should

- `GET /v1/agents/:id` gives a member of someone else's agent what it can do,
  never the owner's host paths (`dataSources[].hostPath`), env-var names or
  the gateway port (v2.39.0).
- `GET /v1/usage` and every other usage view count only the caller's own
  agents (v2.88.4), so a member's request no longer reaches into the owner's
  containers.

## 7. Operational gaps that bite at scale

- ~~`kickRebuild` checks `inflight` but not the `busy` flag, so a batch rebuild
  reports success for agents that were silently dropped~~ — fixed in v2.156.0:
  each queued rebuild is a recorded operation, a rebuild that cannot run ends
  failed with the reason (`hatchabot ops`, Alerts), and bulk source switches
  list busy agents as skipped.
- A process killed **mid-delete** still leaves the agent in `DELETING`: no
  reconcile rule finishes it, and the app shows no Delete in that state. A
  Delete through the API (`hatchabot delete <agent>`) re-enters and finishes
  it. A teardown that fails parks the agent in FAILED with Delete offered
  again, and keys a failed delete left behind are swept at start (v2.160.0).
- ~~Reconcile and `scripts/backup-volumes.sh` skip runner-host agents~~ —
  both cover them now (backups v2.133.0, reconcile v2.134.0).
- ~~Backup restore proceeds after its own safety snapshot fails~~ — fixed in
  v2.91.0: a restore refuses when its safety copy cannot be taken.
- ~~`openclawImport` rewrote the user's live `openclaw.json` non-atomically~~
  — fixed in v2.169.0: a temp file renamed over it.
- ~~`tcp://` runner endpoints were accepted with no TLS enforcement~~ — fixed
  in v2.169.0: TLS only, `--tlsverify`, and refused without a client
  certificate.

## 8. Every DM member shares one conversation thread

*Found 2026-08-30 while investigating a "lost memory" report. Not yet decided.*

OpenClaw keys a direct-chat session per AGENT, not per person: `agent:<slug>:main`.
Every member who DMs the bot writes into that one transcript, and the session's
`route`/`origin`/`lastTo` fields simply track whoever spoke most recently. Group
chats get their own key (`agent:<slug>:telegram:group:<id>`), so the shape is one
shared DM thread plus one per group. (A web-chat guest has conversations of
their own; the owner's Telegram DM and console share the main one.)

**What this means.** Anything a member says is context for the agent's replies to
every other member. Nobody is quoted verbatim to anyone else, but the agent
answers each person carrying what the others told it, and a member can simply ask
it what was discussed. For a family agent that is arguably the point;
for a health, legal, or money agent shared between two people it is not what
either would assume.

The agent's memory (`MEMORY.md`) is one for everyone too: the "private memory"
switch only changed an instruction, and was removed in v2.107.0. Since then
everyone who joins an agent is told its memory is shared (the invite page, the
welcome message, the web chat).

**What "fixed" looks like:** decide whether an agent's threads are shared or
per-member, make it a visible per-agent setting, and — if per-member — route each
sender to their own session key. Until then the advice stands: for something
private, give that person their own agent.

## 9. PARTIALLY CLOSED — session resets: the guards exist, but a reset typed in the chat still loses the thread

*Opened 2026-08-30; corrected 2026-08-31 and 2026-09-06.*

An agent's conversation can end and start fresh in three ways: a `/new` or
`/reset` typed in the chat (or the `sessions.reset` gateway call), OpenClaw's
idle reset after a gap, and a message that arrives seconds after the container
comes back. The previous transcript is never deleted: it is kept beside the new
one as `<session>.jsonl.reset.<time>`.

**Shipped:**

- v0.72.0 — `waitForSkillsSettled` holds an agent in PROVISIONING / REBUILDING
  until its skill inventory stops changing, so it is not messaged seconds after
  its container comes back (a test agent messaged within 35 seconds of a
  restore reset every time; left five minutes, its thread survived).
- v0.114.0 — a 30-day idle window (OpenClaw's default rolled a conversation
  after about a day), the bundled active-memory plugin (a fresh session
  recalls the standing facts from `MEMORY.md` before it answers), and a
  memory habit in every agent's AGENTS.md.
- A checkpoint: **📝 Chat → Memory** (`POST /v1/agents/:id/checkpoint`) has
  the agent write the conversation's key facts into `MEMORY.md` (~20s), and is
  offered pre-ticked before the resets Hatchabot itself causes (a source
  switch, the bulk switch-and-rebuild).
- v0.134.0 — **📥 Recover context** stages an ended conversation into the
  workspace and has the agent save what matters; v2.1.0 — after every rebuild
  Hatchabot checks for a reset and says so on the agent's card.

**Still open:** nothing hooks OpenClaw's **`before_reset`** — the hook fires
with the outgoing transcript's messages, the natural place to hang a
checkpoint — so a `/new` or `/reset` typed in the chat still ends the thread
with no checkpoint. What survives is what the agent chose to write to
`MEMORY.md`, plus Recover context, which the owner has to run.

## 10. Public access rests on its listener's trust rules (accepted risks)

*Since v2.114.0; off unless the machine's owner turns it on. Not yet tried on a
real tailnet.*

"Reach it from anywhere" makes the sign-in page reachable from the internet
through Tailscale Funnel. Its design and safeguards are in
[public-access.md](public-access.md); the rules it stands on are:

- **Trust is decided by the listener, and nothing else.** A request is public
  if and only if it arrived on the public listener (`127.0.0.1:8092`, the one
  port Funnel is pointed at; `src/api/trust.ts`). No header moves a request
  between classes. Anything else on the machine that connects to that port
  is treated as public too, and can choose its own address for the
  per-address limits.
- **Public requests never count as "on this machine"**: no first account, no
  owner's first claim, no command-line, peer or Google bearer tokens, and no
  in-process calls of the management agent. A browser session is the only way
  in.
- **Safeguards a–j must all hold**, or public access cannot be turned on, and
  the public listener answers 503 to everyone while one is off: a sign-in per
  person, a second factor for passwords and owners, only invited people,
  public traffic on its own listener, only classified routes, public limits
  and lockouts, new-device notices, stricter sessions, automatic upgrades on
  `stable`, and a security record.

**Accepted, and stated in public-access.md ("What is NOT protected"):** a flaw
in OpenClaw's gateway reachable by a signed-in guest's chat; a flaw in
Hatchabot's own sign-in code (hence automatic upgrades); denial of service and
cheap lockouts of the *public* address; a stolen signed-in device; chat-only
guests let in on a password alone if the owner turns that on; Google accounts
without owner rights having no second factor there; "Forgot password?" asks
used up from the internet; invitation codes being bearer links; and the
OpenClaw console's own pages served without Hatchabot's content security
policy.

---

*Sources: the 2026-08-25 and 2026-08-27 audits, and the audits since. The
finding lists, including what was fixed, are in `CHANGELOG.md` under the
releases named above.*
