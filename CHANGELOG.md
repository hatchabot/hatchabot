# Changelog

All notable changes to AgentClaw are recorded here. Dates are ISO (YYYY-MM-DD).

## [0.84.0] — 2026-09-01

### Added
- **Send an agent to another user's inbox** — Phase 1 of
  `docs/sharing-and-templates-design.md`. A **📨 Send** action on the card ships
  a trained copy (the same secret-free template as a shared file — persona and
  instructions, no bot token, no members, no history) to another user on this
  server by email, delivered in-app instead of download → email → import. It
  lands in their **📥 Inbox** (header, with a live count badge); they Import it
  as a fresh agent they own, on their own bot, or Dismiss it. A send to an email
  that hasn't signed in yet waits and binds to them on first sign-in. Accounts
  are registered as users sign in, so the recipient picker fills in over time;
  sending by typed email always works.

## [0.83.1] — 2026-09-01

### Fixed
- **The ⋯ card menu is no longer clipped by the jump legend.** It opens leftward
  from the button and its left edge slid under the pinned legend, which (higher
  z-index) rendered on top of it. Raised the menu above the legend so it's fully
  visible. (Opening it rightward instead would push it off the card's right
  edge, since ⋯ is the last action.)

## [0.83.0] — 2026-09-01

### Added
- **"📝 Save chat to memory" on the agent card (⋯ menu, running agents).** The
  standalone form of the pre-switch checkpoint: the agent writes the current
  conversation's key facts into MEMORY.md/today's file on demand (~20s), so they
  survive a reset you can see coming — before archiving, before `/new`, or just
  to force durable facts down. `POST /v1/agents/:id/checkpoint`; it writes to
  memory and resets nothing. The checkpoint prompt was neutralised (it no longer
  claims a reset is imminent) so it's honest whether triggered manually or by a
  source switch. Verified live end-to-end.

## [0.82.0] — 2026-09-01

### Added
- **📊 Sources button on the main page**, beside Health and Usage. Opens a
  breakdown of which agents are on which AI source (with credential type and a
  per-source model split), a per-source agent list showing each agent's current
  model, pins, and pending rebuild-time changes, and a fleet-wide "models in use
  now" histogram — the web equivalent of `agentclaw sources`. Rendered from
  already-loaded data, so it opens instantly.

## [0.81.1] — 2026-09-01

### Changed
- **The agent card names its AI source**, e.g. "Household Claude · claude-opus-4-8",
  so you can see at a glance which source each agent is on without opening
  Settings. Shown only when more than one source exists (with a single source
  it's the same for every agent). Complements the existing per-source rollup
  (Settings → AI sources, and `agentclaw sources`).

## [0.81.0] — 2026-09-01

### Added
- **The memory checkpoint now covers the bulk "Move agents here" path too**, not
  just the single-agent AI switch. The move dialog gains the same default-on
  "Save each conversation to memory first" checkbox, with a note that it adds
  ~20s per agent and only applies when rebuilding now. Each agent's summary runs
  as the first step of its own rebuild, so a fleet move no longer resets every
  conversation unsaved.

## [0.80.0] — 2026-09-01

### Added
- **Save the conversation to memory before switching an agent's AI source.**
  Switching an agent between AI backends (e.g. machine-login → setup-token)
  restarts it on a different engine, which makes OpenClaw reset the live Telegram
  thread — the agent "forgets" what was just discussed. It's an inherent
  consequence of the backend change, not a bug we can suppress (verified: the
  gateway's claude-cli runtime can't read the env token, so the two backends
  can't be made identical). So instead, at the one moment AgentClaw knows the
  reset is coming, it does what OpenClaw's own model prescribes — promote the key
  facts into memory. A checkpoint checkbox (default **on**) on the agent's AI
  tab has the still-running agent write a short summary of the current
  conversation into `MEMORY.md`/today's memory file before the rebuild, so the
  context survives the reset. Best-effort and bounded: a slow or failed summary
  never blocks or fails the switch. Verified live end-to-end. Durable notes the
  agent already saved are unaffected — this is only about the *current* chat.
  Bulk-move integration deliberately deferred until this is exercised more.

### Notes
- The recovered/checkpointed memory also surfaced the standing gap that
  `memory_search` needs: the `local` embedding provider isn't installed
  (`@openclaw/llama-cpp-provider`), so semantic recall over memory files is
  paused fleet-wide (keyword FTS still works). Separate from this change.

## [0.79.1] — 2026-09-01

### Changed
- **A source with no running agent now says why its model list is short.** The
  "+ add model" dropdown is absent on such a source because it can only see the
  offline curated set (which it already lists in full) — not a bug, but it read
  as inconsistent next to a source with live agents showing the full runtime
  catalogue. The empty state now explains: common models only until an agent
  runs on the source, then Sync (or the auto-probe) reveals the rest.

## [0.79.0] — 2026-09-01

### Added
- **"⟳ Sync models" on each AI source** reconciles its switchable-model list with
  what the runtime serves right now. The app already auto-*pruned* models the
  runtime stopped serving (on dialog open), but never *added* newly-shipped ones
  — so a new Claude model showed in the "+ add" dropdown yet agents couldn't
  switch to it until it was added by hand. Sync closes that in one click. A
  confident live answer (a running agent to probe) is authoritative — adds new,
  drops retired; without a running agent it can only add, never remove, so a
  source isn't shrunk to the offline fallback. It reports exactly what changed.

## [0.78.1] — 2026-09-01

### Changed
- **The default-model field is a real dropdown when adding an Anthropic source**,
  so you can pick the default (sonnet, haiku, …) at creation instead of it always
  reading `claude-opus-4-8`. The previous autocomplete looked single-valued
  because it was prefilled. An "Other (type an id)…" option keeps a newer,
  not-yet-listed model reachable; local and Gemini sources keep the plain field.

## [0.78.0] — 2026-09-01

### Fixed
- **A new Anthropic AI source now comes with the full Claude line-up as
  switchable models**, instead of being stuck on its single default. A source
  created with no explicit `models` (the normal case from the web form) was
  stored with an empty alternates list, so every agent on it could only run the
  default until the owner hand-added each model — which read as "the setup-token
  source only offers one model." Subscription and Anthropic-API-key sources are
  now seeded with the curated Claude set (the same list the model picker offers
  and the usage rollup prices against); an explicit list still wins, local and
  Gemini sources are untouched, and the runtime auto-clean still prunes any
  model the CLI doesn't actually serve once a live agent exists.

## [0.77.2] — 2026-09-01

### Changed
- **"Add source" moved above the "Voice & media" section**, right under the
  source fields it belongs to — it had been stranded below an unrelated section.
- **A Show/Hide toggle on the API-key and setup-token fields**, so you can
  reveal what you pasted to check the copy was right, then hide it again. The
  value never leaves the field either way.

## [0.77.1] — 2026-09-01

### Added
- **The "Default model" field is now a Claude-model picker**, not blind
  free-text. For an Anthropic source (subscription, or an API key with vendor
  Anthropic) it offers the known Claude model ids as a dropdown, prefills
  `claude-opus-4-8`, and still accepts a hand-typed newer id — so the common
  case needs no typing and a typo can't silently create a source that provisions
  green and fails on first use. Gemini and local sources keep a plain field with
  a format hint.

## [0.77.0] — 2026-09-01

### Added
- **A fleet-by-source / by-model summary.** `agentclaw sources` prints which
  agents are on which AI source, a model histogram ("what everything runs now"),
  and a per-source agent list with pins and pending rebuild-time model changes.
  In the web app, each AI source now carries an expandable "<n> agents · Nx
  <model>" line listing its agents and their current models — the summary lives
  where you manage sources.

### Fixed
- **"Move agents here" is disabled when every agent is already on that source**,
  instead of a click that produced only a fleeting toast (or, if missed, seemed
  to do nothing). The button's tooltip says why, and shows the movable count
  when there is one.

## [0.76.2] — 2026-09-01

### Fixed
- **A `claude setup-token` pasted into the API-key field is now refused** with
  guidance, instead of being stored as `ANTHROPIC_API_KEY` and failing every
  request with an opaque "something went wrong" in Telegram. A setup-token
  (`sk-ant-oat…`) is an OAuth credential and must be a **subscription** source,
  where it's injected as `CLAUDE_CODE_OAUTH_TOKEN`; a real API key (`sk-ant-api…`)
  is unaffected.
- **The subscription source's token field no longer says "Mac only."** On Linux,
  pasting a setup-token is the way to run Claude Max *without* mounting
  `~/.claude` into every agent — the safer choice on a shared or exposed box —
  so the field now explains that tradeoff instead of discouraging it.

## [0.76.1] — 2026-09-01

### Changed
- **"Move agents here" now uses a checkbox list**, not a typed-in names prompt —
  tick the agents to switch, "Select all", with a live count and rebuild-now vs
  rebuild-later, mirroring the model-apply dialog. Only agents not already on the
  source are listed.

## [0.76.0] — 2026-09-01

### Added
- **Switch many agents' AI source in one call.** `POST
  /v1/ai-profiles/:id/adopt-agents` moves a batch of agents onto one source
  (`:id` is the destination); omit `apply` to move *all* of your agents not
  already on it, or name a subset. Same per-agent rules as the single switch: a
  machine-login Max source that can't reach a runner-hosted agent is reported in
  `skipped` rather than failing the batch, and a model pin the new source
  doesn't offer is dropped so the agent falls back to the new default. `rebuild:
  true` applies immediately; otherwise each agent shows "rebuild to apply".
  Surfaced as `agentclaw switch-source --to <id|name> [--agents a,b] [--rebuild]`
  and a "Move agents here…" button on each AI source in Settings. This is the
  fleet-wide lever for moving off the machine-login `~/.claude` mount onto a
  setup-token source (see the security audit / pre-production #1).

## [0.75.0] — 2026-09-01

### Added
- **`agentclaw users` — the people roster.** Every Telegram user across your
  agents: which agents they belong to and their role, when they joined, and
  when they were last heard from (`--all`, host owner: every account's agents).
  Backed by `GET /v1/users`. One honesty caveat, stated in the output: OpenClaw
  keeps one shared session per agent DM thread and records only the *last*
  exchange per thread, so "last exchange" shows the most recent speaker — an
  earlier speaker in the same thread shows the older reading from whenever they
  were last the latest. Per-message per-user history isn't recorded anywhere,
  and the command doesn't pretend otherwise. Container reads are batched six at
  a time (26 concurrent execs measurably slowed the box once before) and cached
  for a minute; a failed read degrades to memberships-only rather than sinking
  the roster.

### Fixed
- Removed a stray empty `test/agents.test.ts` that made the suite report a
  failed file with zero failed tests.

## [0.74.0] — 2026-09-01

### Added
- **Per-agent runtime image pin.** An agent can now run a specific image instead
  of the fleet's `:latest` — Settings → Definition → "Runtime image", host owner
  only (any local image is runnable by name, so this is the machine owner's
  call, like host paths). Applies on the next rebuild; the seed one-shots run on
  the pinned image too, so a candidate is exercised by its own seed path. The
  card shows 📌 with the tag — a forgotten pin would otherwise quietly strand an
  agent on an old image forever — and a pinned agent is exempt from "update
  available", which would only fight the pin. The pin is deliberately not
  validated against `docker images`: pinning an image that is *about to exist*
  is the normal candidate workflow, and a wrong name fails the next rebuild
  loudly with Retry.

  This is the foundation for derived images (per-owner "extra system packages"
  built `FROM` the base) and, later, for the management agent driving that
  pipeline — design in docs/features.md "Adding tools to an agent".

## [0.73.0] — 2026-09-01

### Added
- **Agents are now told how to install tools.** Every mechanism already existed
  — `$HOME` survives rebuilds, `~/.local/bin` is on PATH, `~/.npm-global` is the
  npm prefix, `~/.openclaw/pylibs` is on PYTHONPATH, `on-rebuild.sh` runs after
  every rebuild — but the only place any of it was written down was comments in
  AgentClaw's own source. An agent asked to "install ffmpeg" would try `apt`,
  fail, and the request escalated to a human, which made the whole system feel
  developer-dependent when it isn't. A managed "Installing tools" section is now
  synced into every agent's `TOOLS.md` on provision and rebuild (created if
  OpenClaw hasn't seeded the file yet; the agent's own notes around it are
  never touched). Adding a tool is now a chat message to the agent, end to end.

## [0.72.0] — 2026-08-31

### Fixed
- **An agent messaged seconds after a restore no longer loses its conversation.**
  Measured: Art Advisor reset its thread when messaged 11s, 15s and 35s after a
  container came back, and kept it perfectly when messaged five minutes later —
  same session, Van Gogh exchange intact. The fault was ours: an agent was
  called live the moment its gateway answered a health check, while things a
  reply is judged against were still moving — not least because
  `runRebuildHook` can install skills seconds earlier on the same code path.
  Provision and rebuild now wait for the agent's skill inventory to stop
  changing (two identical readings) before going live.

  It is deliberately a **proxy** for "done moving", not a claim about the
  mechanism inside OpenClaw, which is still unidentified — a probe that waits
  for the agent to settle helps either way. It is bounded
  (`AGENTCLAW_READY_TIMEOUT_MS`, default 90s) and never fails a provision: an
  agent that won't settle goes live anyway, because late beats broken. Each run
  logs `runtime.ready` with the settling time and poll count, so whether this is
  the right proxy gets answered by production rather than by argument.

## [0.71.0] — 2026-08-31

### Added
- **"Sync name" on the agent's ⋯ menu.** Points the Telegram bot's display name
  at the agent's current name on demand. The automatic paths only cover pool
  bots; a bot you minted or adopted yourself is never renamed unasked, because
  someone else's bot isn't ours to touch — asking is what makes it fine. It
  answers honestly when Telegram refuses, with the time you may retry, rather
  than appearing to work.
- **The card reports the rename, both halves.** While it's pending: what the bot
  will be called and how long the wait is ("in about 3 hours"), plus the note
  that Telegram limits renames and nothing else is affected. When it lands: a
  confirmation for half an hour, then it ages out. A wait that runs for hours
  shouldn't end with a warning silently vanishing — that reads as though it was
  never real.

## [0.70.1] — 2026-08-31

### Added
- **The pool prefers a bot it can still rename.** Telegram's `setMyName` quota
  is per bot and measured in hours, so a bot renamed minutes ago cannot take a
  new agent's name — and a bot serving "Tax Advisor" while Telegram still calls
  it "Condo Adviser" is more confusing than a neutral one. Lease selection now
  sorts rate-limited bots last. When every free bot is limited this changes
  nothing; there is simply no better pick.
- **The card explains a stale bot name** instead of leaving you to wonder. While
  a rename is parked, the agent shows what the bot will be called and roughly
  when, with the note that Telegram limits renames and nothing else is affected.

## [0.70.0] — 2026-08-31

### Fixed
- **A restored agent's bot stayed called "AgentClaw (unassigned)" — because the
  archive itself spent the rename.** Telegram rate-limits `setMyName` by HOURS,
  not seconds: a live restore came back `Too Many Requests: retry after 11942`
  — 3h19m. Every archive→restore was spending two renames against that quota,
  one to the idle name and one straight back to the same agent, so the second
  was refused and the live agent wore "unassigned" until the limit expired. Now:
  - **Release parks the idle name instead of applying it** (15 min, tunable via
    `AGENTCLAW_IDLE_RENAME_MS`). A bot re-leased before that spends no rename at
    all; one genuinely left in the pool still stops advertising a departed agent.
  - **`getMe` is checked before spending a rename.** It isn't rate-limited the
    way `setMyName` is, so a bot that already wears the right name — the usual
    case after a deferred release — costs nothing.
  - **Telegram's `retry_after` is respected.** The repair sweep was retrying a
    three-hour limit every two minutes; it now waits for the deadline it was
    given.

## [0.69.3] — 2026-08-31

### Changed
- **The archived section is called "Archived"**, not "Archived · n" — it is a
  section header, and the count was noise next to the cards it sits above.
- **The jump legend lists archived agents by name**, under an "Archived" header,
  the same treatment a group gets. They were previously collapsed into one
  counted line, so an agent disappeared from the legend the moment it was
  archived — exactly when you go looking for it. Clicking one opens the drawer
  on the way, as before.

## [0.69.1] — 2026-08-31

### Changed
- **Corrected the "restore lost its memory" diagnosis, and recorded it.** Two
  earlier explanations were wrong. The transcript is never deleted by archiving,
  and the reset is not caused by the agent's skills changing (that diff was
  coincidental — the two prompt snapshots were 42 hours apart). OpenClaw's reset
  policy, with no `session` key configured, resolves to `mode: "daily",
  atHour: 4`: a session is stale if it *started* before the most recent 4am
  boundary in the container's timezone, which is UTC. Both of Art Advisor's
  resets fit that rule exactly, and the second one landed 21 seconds after a
  restore purely because that was the next message. Documented as
  `docs/pre-production.md` §9 together with the fact that nothing checkpoints a
  conversation anywhere durable before the nightly rollover.
- **Recorded that every DM member shares one conversation thread**
  (`docs/pre-production.md` §8). OpenClaw keys direct sessions per agent, not per
  person, so all members write into one transcript — verified on a three-member
  agent with 223 messages in a single session file. The per-agent Shared memory
  toggle does not govern this.

## [0.69.0] — 2026-08-30

### Fixed
- **A bot rename that never reached Telegram is now retried, and remembered if
  it still fails.** Restoring an archived agent left its bot named "AgentClaw
  (unassigned)": the logging added in 0.66.0 showed `setMyName` failing with a
  bare `TypeError: fetch failed` — a transport error, 49 seconds after the same
  call had succeeded — while the box was churning docker networking mid-restore.
  Only rate limits were retried, so a network failure got exactly one attempt
  and the wrong name stuck until the next rebuild. Now: transport failures are
  retried with backoff (a refusal from Telegram still isn't — that's an answer,
  not a network problem), the error carries `.cause` instead of an unhelpful
  "fetch failed", and a rename that still doesn't land is parked on the pool row
  and finished by a background sweep. The sweep costs nothing on a healthy pool,
  since only a failed rename leaves anything to do.

### Changed
- **Archive/Restore no longer promise "memory intact".** They keep everything
  the agent has *learned* — its workspace files are untouched — but OpenClaw
  begins a fresh conversation thread whenever an agent's skill set differs from
  the one the current thread started with, so a restore can arrive without the
  recent chat history. This is not specific to archiving (a rebuild does the
  same, and did so here on 2026-08-29, eleven seconds after `runtime.rebuilt`),
  but the wording implied otherwise. The old transcript is kept beside the new
  one as `<session>.jsonl.reset.<timestamp>`.

## [0.68.1] — 2026-08-30

### Changed
- **Agent cards name the machine they run on**, e.g. `on dgx-spark` instead of
  `on this machine`. The phrase was ambiguous the moment a second host existed,
  and on a phone it reads as the phone. `GET /v1/hosts` now carries the local
  host's live `hostname` alongside its stored label, so the card stays right if
  the box is renamed — the label is written once at first boot and never
  revisited. Runners are still named by their label.

## [0.68.0] — 2026-08-30

### Changed
- **Archive replaced Stop on the agent card**, and Stop moved into the ⋯ menu.
  On a fleet bounded by how many bots Telegram lets you own, putting away an
  agent you're done with matters more than pausing one — and Stop keeps holding
  the bot, which is rarely the point. The same slot becomes **Restore** once the
  agent is archived, so the button that put an agent away is the one that brings
  it back.
- **Archived agents collapse into their own drawer** at the bottom of the fleet,
  closed by default, instead of sitting inline among the agents you run. It
  stays open across the list's polling re-render, and the jump legend carries a
  single "Archived · n" line rather than an entry each. Jumping to an archived
  agent opens the drawer first — a card inside a closed `<details>` has no
  layout to scroll to.

### Added
- **CLI: `agentclaw archive <agent>` and `agentclaw unarchive <agent>`.**
  Deliberately *not* `restore`: that verb already means "restore from a
  downloaded .agentclaw file", and quietly redefining it would have shadowed the
  older command.

### Fixed
- **A parked "paste a bot token" step no longer follows an agent into the
  archive.** It would have left the archived card asking for a token for an
  agent that isn't running, and kept the fleet's needs-attention count up
  forever. A token stashed but never committed is discarded too, so a later
  restore doesn't silently provision onto an identity we'd given up.

## [0.67.0] — 2026-08-30

### Added
- **Archive an agent: keep everything, give the bot back.** Telegram caps an
  account at roughly 20 bots and every agent holds one whether it is busy or
  idle, so the bot — not disk, not CPU — is what limits how many agents you can
  have. Archiving parks an agent whole (container, volume, memory, members,
  settings) and returns its Telegram bot to the pool for another agent to lease.
  A hand-pasted token is parked in the pool too, since it burns the same
  BotFather slot. Available from the ⋯ menu on RUNNING, STOPPED or FAILED
  agents — a broken agent still sits on a token somebody else could use.
- **Members are told, in the chat, before the bot changes hands.** The old bot
  sends "— archived —" while it still looks like the agent they knew, and the
  wording is deliberately different from a deletion: nothing was lost, and the
  agent will return on a NEW bot whose link somebody has to hand them. This
  also fixed a gap on the delete path, where members of an agent with a *pasted*
  bot got no goodbye at all — the token is parked in the pool a moment before
  release, so there was no lease left to look up.
- **Restore** leases a fresh bot and boots the agent with its memory intact. It
  re-enters provisioning rather than simply starting, because the identity must
  be leased again; if the pool is dry it parks on the usual paste-a-token step
  instead of failing. Nobody has to pair again — Telegram user ids are global
  rather than per-bot, so the allowlist rebuilds itself from the members.

## [0.66.0] — 2026-08-29

### Fixed
- **A working agent could be marked "Setup was interrupted — tap Retry".** The
  reconcile sweep makes one docker call per agent, so on a 30-agent fleet the
  agent list it started from is a minute stale by the time it reaches the end.
  An agent that was mid-setup when the sweep began — no runtime yet, state
  PROVISIONING — had since finished, and reconcile judged it on the old copy:
  live, it marked an agent FAILED 21 seconds after that agent reported healthy.
  The busy flag was no defence, because it had been correctly *cleared* when
  provisioning finished — the data aged, not the lock. Every agent is now
  re-read immediately before it is judged, and again after the docker call
  (which is its own staleness window).
- **A pool bot's rename is no longer silent.** Renaming a leased bot is
  best-effort, and one that failed left the bot advertising "AgentClaw
  (unassigned)" with nothing in the log to say whether the call had failed or
  never happened. The outcome is now logged with Telegram's own words, a short
  rate limit (≤10s) is waited out and retried once, and Rebuild/Retry re-apply
  the name — so a bot that lost that race heals instead of staying mislabelled
  for the life of the agent. A hand-minted bot is still never renamed here: it
  belongs to whoever created it.

## [0.65.0] — 2026-08-29

### Changed
- **A new agent now appears at the TOP of its section, not the bottom.** You
  watch the thing you just created — it provisions, it may want a bot token, it
  may fail — and appending it meant scrolling past the whole fleet to find it.
  Deliberately *not* applied to Settings → Section: moving an agent between
  sections is a considered act and still drops it at the end.
- **A recycled pool bot no longer wears the previous agent's name.** `release()`
  renames the bot to "AgentClaw (unassigned)" as it goes back in the pool, and
  leasing it renames it to the new agent — so a free bot stops advertising a
  deleted one, and a re-leased bot's chat header reads correctly. (The immutable
  `@username` still can't change; only the display name can.)

### Added
- **Telegram history gets an honest seam when a bot changes hands.** A bot can't
  clear a chat — history is per-user and only *recent* bot messages are
  deletable — so instead of pretending, both ends of the lease are marked: on
  release, members get "end of this agent"; on re-lease, anyone who chatted with
  that bot before gets "— this bot is now <name> —, anything above ... no longer
  applies". A never-leased bot stays silent, having nothing to disown.

## [0.64.0] — 2026-08-29

### Changed
- **"OpenClaw (debug)" now explains itself instead of failing cryptically.** The
  Control UI needs a browser *secure context* (`https://` or `localhost`) for the
  WebCrypto it uses as device identity — Tailscale encrypting the wire doesn't
  count, since the browser judges by URL scheme alone. Clicking it from a
  plain-HTTP origin used to open a tab that loaded and then said "Could not
  connect"; it now says up front what's needed and how to get it. Also trimmed
  the comment there, which had accumulated a stale layer from each failed
  attempt.

### Added
- **`docs/control-interfaces.md` §C — Direct OpenClaw access.** Records why this
  stays an owner-only debugging tool: the secure-context requirement and its
  three workarounds (localhost, SSH tunnel, `tailscale serve` — including that
  the certificate is published in public Certificate Transparency logs), and the
  larger point that the Control UI is an admin console **with a terminal**, so
  granting it to members would bypass the membership model rather than extend
  it. If the goal is "users talk to the agent without Telegram", the note
  recommends an in-app chat panel instead — same auth, no secure context, no
  extra onboarding.

## [0.63.6] — 2026-08-29

### Fixed
- **"OpenClaw (debug)": stopped sending the parameter that was blocking it.**
  0.63.2 added an explicit `gatewayUrl` on the theory the UI couldn't find its
  gateway. Reading further showed the opposite: the Control UI already derives
  it from the page it was served from — `ws(s)://<host><pathname>` — which is
  exactly this proxy. Handing it an address instead marks it *pending* until the
  user approves a "Change Gateway URL" prompt, and while pending the UI
  withholds the token as well, producing the "Could not connect" it was meant to
  cure. Now only the token is passed, and the UI connects to the proxy on its
  own. Verified: the upgrade returns `101` at both paths the UI can derive
  (with and without the trailing slash).

## [0.63.5] — 2026-08-29

### Added
- **The running version is shown beside the AgentClaw title** — a small `v0.63.5`
  chip in the header. A console line was easy to miss, and "which build is this
  browser actually running?" turned out to be the question behind several
  rounds of a fix appearing not to work. Now it's answerable at a glance: if the
  chip lags the server after a reload, something is serving a cached page.

### Fixed
- **Bumped the service-worker cache** (`agentclaw-shell-v1` → `v2`). An
  installed PWA could still hold a shell cached before the app was served
  `no-store`; `activate` deletes every cache that isn't the current name, so
  the stale copy is now evicted.

## [0.63.4] — 2026-08-29

### Fixed
- **The app shell was served with no cache headers**, so a browser was free to
  keep an old copy of `index.html` — and since the whole app is that one file,
  a shipped fix could sit unused behind a stale tab, which is indistinguishable
  from "the fix doesn't work". It's now `Cache-Control: no-store,
  must-revalidate`.

### Added
- **The running version is stamped into the page** as `window.AGENTCLAW_VERSION`,
  logged to the console on boot, and returned as an `x-agentclaw-version`
  response header — so "which build is this browser actually running?" is a
  question with an answer instead of a guess.

## [0.63.3] — 2026-08-29

### Changed
- **The Control UI needs one approval the first time — the app now says so.**
  With a real browser session the proxy is provably working end to end (page
  `200`, upgrade `101`, and the gateway's `connect.challenge` arriving), so the
  remaining "Could not connect" was not a proxy fault: OpenClaw deliberately
  refuses to point its Control UI at a gateway address it was handed until the
  user approves a **"Change Gateway URL"** prompt — and while that approval is
  pending it doesn't apply the token either, so the tab reports a connection
  failure. Opening the debug UI now explains this. It's once per browser; the
  choice is stored.

## [0.63.2] — 2026-08-28

### Fixed
- **"OpenClaw (debug)" now actually connects.** Proxying the page and its
  WebSocket wasn't enough: the Control UI does **not** infer its gateway from
  the page location — it reads an explicit `gatewayUrl` from the query or hash
  and otherwise falls back to a default that isn't reachable through the proxy,
  which is what produced *"Could not connect."* The button now passes
  `gatewayUrl` alongside the token, matching the page's scheme so an HTTPS
  deployment gets `wss://`. Both still ride in the URL fragment, which browsers
  never send to a server.
- Tests now cover the proxy end to end against a stand-in gateway: an owner's
  upgrade is forwarded **and bytes flow both ways** (a handshake that 101s but
  never pipes is still a dead UI), while an upgrade with no session, or for an
  agent the caller doesn't own, has its socket destroyed.

## [0.63.1] — 2026-08-28

### Fixed
- **The proxied Control UI now connects.** v0.63.0 proxied the page but not its
  WebSocket, so it loaded and then reported *"Could not connect."* The upgrade
  is now proxied too — and authorized properly: `auth.ts` exposes a single
  `principalFromCookieHeader` resolver (implemented once per auth mode) that the
  raw-server upgrade handler shares with the HTTP hook, so the two cannot drift.
  An upgrade with no session, or for an agent the caller doesn't own, has its
  socket destroyed rather than forwarded — verified. This is why the WebSocket
  wasn't shipped in 0.63.0: deriving the principal by hand there would have
  fallen back to `LOCAL_OWNER` and forwarded unauthenticated upgrades on a
  password-mode install.

## [0.63.0] — 2026-08-28

### Fixed
- **Copy buttons inside dialogs did nothing.** `showModal()` puts a dialog in
  the top layer and makes the rest of the document inert, so the clipboard
  fallback's textarea — parented to `<body>` — could never take selection and
  the copy silently failed. It now attaches inside the open dialog. Fixes both
  invite copies, and the CLI-token and bot-token copies, which are also modal.
- **"OpenClaw (debug)" opened a dead tab for anyone not sitting at the
  machine.** The gateway port is published on the host's loopback deliberately
  (it grants full control of that agent), so pointing a browser straight at it
  only ever worked locally — from a tailnet browser the tab just hung. The
  Control UI is now reverse-proxied through the control plane at
  `/v1/agents/:id/ui/`: same-origin, authorized by the session you already
  have, with the port still closed. The gateway's own token continues to ride
  in the URL *fragment*, which browsers never send to a server.

### Added
- **An agent's Telegram bot is renamed when the agent is.** The bot's display
  name (the chat header — the `@username` is immutable) was set once, when a
  pool bot was leased, and then froze; a hand-pasted bot was never named at
  all. Renaming an agent now updates it, best-effort.

### Known gap
- The Control UI's **WebSocket** (live updates) is not proxied yet, so the page
  loads and its HTTP calls work but live data will not stream. Fastify never
  sees an upgrade, and authorizing one means re-deriving the principal from raw
  headers — duplicating `auth.ts`'s session logic across password and identity
  modes. A faked principal falls through to `LOCAL_OWNER`, which on a
  password-mode install would forward an *unauthenticated* upgrade, so it was
  left undone rather than done unsafely.

## [0.62.1] — 2026-08-28

### Fixed
Two defects in the home-as-volume change, both caught by migrating a single
low-stakes agent before touching the fleet. No data was lost — the named volume
was correct throughout; only the runtime view of it was wrong.

- **The image declared `VOLUME ["/home/node/.openclaw"]`.** With the home volume
  mounted at the parent, Docker auto-created an **anonymous** volume at that
  path, which shadowed the real workspace with an empty directory — the gateway
  started with no config and never came online. Removed the declaration and
  rebuilt the runtime image.
- **The migration created `.openclaw` as root.** It runs in a one-shot container
  as uid 0, but the agent runs as uid 1000, so the gateway couldn't open
  `openclaw.json.lock` (EACCES). The migration now chowns the volume root and
  the new directory to 1000:1000; moved content already carried correct
  ownership.

Verified end to end on a real agent: all seven workspace files byte-identical
across the migration, a single volume mounted at `/home/node`, `~/.local/bin` on
PATH — and a file written to `~/.config/` **survived a full rebuild**.

## [0.62.0] — 2026-08-28

### Changed
- **An agent's `$HOME` is now its persistent volume, so capability it gives
  itself survives a rebuild.** Previously only `~/.openclaw` persisted, so an
  agent told in chat to "set up Jira" did the natural thing — wrote
  `~/.config/atlassian/env` — and lost it on the next rebuild. Fixing that
  per-tool (as `GOG_HOME` did for Google) doesn't scale to tools nobody has
  thought of yet.

  The boundary now matches the Unix model the agent already assumes:
  **`/usr` is the image, replaced by a rebuild; `$HOME` is the agent's and
  persists.** `~/.config`, `~/.local`, `~/.ssh`, and anything else in home
  survive by default — and because the volume is what backups, Move and
  export carry, those capabilities travel with the agent too.

  Absolute paths are unchanged (the volume holds `.openclaw/`, so
  `/home/node/.openclaw/…` still resolves). Existing volumes are reshaped
  automatically on their next provision or rebuild: idempotent, marker-guarded,
  written last so a half-finished run self-heals, and it runs before anything
  writes to the volume. Archives made before this change are detected on import
  and restored to the right place, so old backups and `.agentclaw` files
  still work.

### Added
- **`~/.local/bin` and a home npm prefix are on `PATH` for every process**, so a
  CLI the agent installs for itself is runnable by name next time — set in the
  container environment rather than a login-shell profile, because Claude Code
  spawns plain `bash -c`.
- **An optional `~/.openclaw/on-rebuild.sh`**, run after every provision and
  rebuild. `$HOME` persistence covers state; this covers the rest — a system
  package or anything installed outside `$HOME` — as one script the agent
  maintains itself rather than a framework each capability must be plumbed
  into. Best-effort and timeout-capped: a broken hook can't fail a rebuild.

## [0.61.0] — 2026-08-28

### Fixed
- **The app no longer goes sluggish every ~24 seconds.** Every third poll cycle
  checked each running agent for pending "wants to join" requests by running
  `openclaw pairing list` — booting the whole OpenClaw Node CLI inside each
  container. Measured on a 26-agent fleet: **2.1s per agent, 7.7s of wall time,
  and 26 concurrent `docker exec`s per sweep**, which made every other request
  **6× slower** while it ran (a typical button press went 0.21s → 1.23s).

  Pending requests are just a JSON file on the agent's volume, so
  `listPairingRequests` now reads that file instead. Measured after:
  **0.05s per agent, 0.16s per sweep** (49× faster), and a button press during a
  sweep is 0.18s — indistinguishable from idle. Approving still goes through the
  CLI, which is the part that actually mutates state and updates the allowlist.

## [0.60.1] — 2026-08-28

### Fixed
- **"N instant bots ready" now updates without a page reload.** The pool count
  was only refetched on a metadata refresh, but deleting an agent parks its bot
  back in the pool — so the header kept the old number until you reloaded. It is
  now refreshed on every poll, which also covers the cases that never went
  through the open tab at all: a create leasing a bot, and changes made from the
  CLI, the management bot, or another account. The endpoint is a COUNT plus a
  small roster, so the added cost is noise next to the agent list already
  fetched each cycle.

## [0.60.0] — 2026-08-28

### Changed
- **Sharing a machine-login Claude Max source works again — deliberately, and
  documented as a pre-production blocker.** v0.59.0 closed the cross-owner
  `~/.claude` mount; on this single-household installation every account is
  trusted and household sharing is wanted, so the three checks are relaxed
  again. They are not silently reverted: each site carries a `⚠ ACCEPTED RISK`
  comment naming the exact check that belongs there, and the reasoning lives in
  the new **`docs/pre-production.md`**.

### Added
- **`docs/pre-production.md`** — what must change before AgentClaw serves anyone
  the operator doesn't personally trust. Covers the accepted `~/.claude` risk,
  un-sharing not revoking, the fleet media key reaching every account,
  first-sign-in claiming the installation, missing container capability drops,
  member over-disclosure, and the operational gaps (busy-flag rebuild drops, no
  `DELETING` reconcile, runners skipped by reconcile and backups).

## [0.59.0] — 2026-08-27

### Fixed (security audit — 6 parallel reviewers over the whole codebase)

- **CRITICAL — a shared Claude Max "machine login" source mounted the owner's
  `~/.claude` read-write into another account's container.** `buildRuntimeSpec`
  mounted `claudeAuthDir()` for any subscription profile with no owner check and
  no `readonly`, while create/switch accepted a `shared` profile from any
  account on the shared local host. A second account's agent therefore received
  the profile owner's OAuth refresh token, every Claude Code transcript under
  `~/.claude/projects/`, and **write** access to `settings.json` (whose hooks
  execute as that owner). Confirmed live on this installation. The mount is now
  gated on `profile.ownerId === agent.ownerId`, and both create and
  profile-switch refuse a machine-login source belonging to someone else,
  pointing at setup-token sources instead.
- **HIGH — a malformed backup could crash the control plane.** `importState` and
  `importWorkspace` wrote the archive to a `docker run` stdin with no `error`
  handler; a corrupt archive fails `gzip -t`, the child exits, and the write
  raised EPIPE as an *unhandled stream error* — an uncaught exception that takes
  the process down. `#runStdin` already guarded this exact race; the guard is now
  on all three.
- **HIGH — `destroy()` could not fail, so three "the runtime may have survived"
  guards were dead code.** Every non-zero docker exit became a returned result,
  so a move whose cleanup failed restarted the source while the target still ran
  (two pollers on one bot token), and delete tombstoned agents whose runtime was
  still alive. It now throws on a real failure while staying idempotent for
  already-gone containers.
- **HIGH — `syncDataSourceDocs` could delete the user's AGENTS.md content.** The
  heading match was an unanchored `indexOf`, so `### Data sources`, a mention in
  prose, or the phrase inside a fenced code block was rewritten instead of the
  real section; and with no `## ` heading following, everything below was
  discarded. `replaceSection` is now line-anchored, fence-aware, ends at the next
  heading of any level, and preserves the trailing newline. The duplicated
  embedded-JS copy of this logic is gone — the sync now reads, computes in one
  place, and writes atomically via tmp+mv.
- **MEDIUM — stored XSS via an imported archive.** `deepLink` was the one
  manifest field with no validation (siblings all have strict regexes) and
  landed in an `href`; `esc()` blocks attribute breakout but not a `javascript:`
  scheme. It is now schema-checked *and* re-derived from the verified
  `accountId`, so the archive's value is never trusted.
- **MEDIUM — `agentclaw share` shipped MEMORY.md while promising it hadn't.**
  The CLI called `/export` with no query string, and the route includes memory
  unless asked not to — then printed "no bot token, members, or memory. Safe to
  send to someone." It now excludes memory by default, with `--include-memory`
  to opt in (and a blunt warning when you do).
- **MEDIUM — cross-owner model pins were cleared on a shared source.**
  `clearStaleAgentModels` was scoped by profile only, so editing a shared
  profile nulled other accounts' per-agent pins and drifted their agents onto
  your default. Now owner-scoped, with regression tests for both the PATCH and
  apply-default-model paths.
- **MEDIUM — `agentclaw download` wrote a bot-token-bearing archive 0644.** Now
  0600, matching every other credential file in the project.
- **LOW — the secret-redaction helper masked the wrong argv slot**, leaving the
  value visible for `config set <path> <secret> --replace`. It now redacts by
  position rather than `argv.at(-1)`.

### Audited and found sound

No command/shell/argument injection anywhere (every docker/ssh/git call uses
argv arrays or `shq()`); no IDOR on child objects; no membership escalation; the
state-transition table admits nothing illegal; `npm audit` clean; the runtime
image runs non-root with a sha256-pinned `gog`; secrets are AES-256-GCM at rest,
CLI tokens hashed, and no secret is returned by any route or written to any log.

## [0.58.0] — 2026-08-27

### Added
- **Model lists refresh every time you open ⚙ Settings → AI, and obsolete models
  clean themselves out.** The list was fetched once per page load and cached, so
  a model the runtime had stopped serving stayed pickable until you reloaded.
  It's now refetched on every open, and any model a source still lists that its
  runtime does not serve (`claude-opus-5` being the case that broke compaction
  fleet-wide) is **removed from that source's switchable list automatically**,
  with a toast naming what went.

  The cleanup only ever acts on a confident live answer from the runtime — never
  on the offline curated fallback — so a momentary hiccup can't prune a working
  menu. `available-models` now returns `{ models, stale, source }`: `models` is
  what the runtime genuinely serves, `stale` is what the profile still lists but
  the runtime won't. Previously the two were blended, which is precisely how an
  unservable model stayed on offer.

  If the source's **default** model is the unservable one, it is flagged in red
  rather than silently switched — changing the default changes what every agent
  following it runs, so that stays your call.

## [0.57.0] — 2026-08-27

### Fixed
- **The model picker no longer offers models the runtime can't actually serve.**
  The Anthropic model list was hardcoded and included `claude-opus-5`. OpenClaw's
  `claude-cli` (Claude Max) runtime has **no catalog entry** for it, so an agent
  set to it looked fine — ordinary messages passed through — but **compaction**,
  which resolves the model strictly, failed the moment a conversation filled up:
  *"Unknown model: anthropic/claude-opus-5 … registering it there will not make
  it usable."* Because it was a profile **default**, it had propagated to 26
  agents fleet-wide.

  The picker now asks a live agent on that profile what its runtime really
  serves (`openclaw models list --provider … --all --json`) and offers only
  genuinely catalogued models. Mere presence in that list isn't enough — it also
  reports models AgentClaw itself configured — so entries are validated by their
  metadata: a real model has a display name ("Claude Opus 4.8"), while an
  unservable one is echoed back with its raw id as the name and placeholder
  specs. Models the profile already uses are never dropped from the list, and
  with no live agent to ask it falls back to a curated list — from which
  `claude-opus-5` has been removed.

- **`apply-default-model` now reports what it actually changed.** `applied`
  echoed the number of ids passed in, so a shared profile whose request included
  another account's agents over-reported (those are correctly filtered out and
  left untouched). It now counts only agents this call really touched.

## [0.56.1] — 2026-08-27

### Changed
- **Scrubbed personal identifiers from the source, docs, and tests** — the repo
  should carry no one's real details. Replaced a real Google account in
  `docs/connections-design.md` with `building-adviser@example.com`, the owner's
  real Telegram user id (in 7 files) with the obviously-synthetic
  `1000000001`, a real Tailscale hostname in a `routes.ts` doc comment with
  `my-host.example.ts.net`, and first-name references in comments, fixtures and
  e2e scripts (`ownerId: 'chris'` → `'test-owner'`) with generic equivalents.
  Placeholder mail is now `@example.com` throughout. Audited alongside it: no
  real credentials, bot tokens, or API keys are committed — every key-shaped
  string in the tree is an obvious fixture. The `LICENSE` copyright line is
  intentionally unchanged.

  Note this cleans the **working tree**; the previous values remain in git
  history (the repository is private).

## [0.56.0] — 2026-08-27

### Added
- **A repo that won't clone now says so on the agent's card.** A failed git
  sync was only a line in the audit log — `datasource git sync failed`, with the
  repo name and reason buried in the event detail — so it hid among the
  successes and you had to dig to learn *which* repo broke and why. The failure
  is now recorded on the data source itself (`syncError`, cleared on the next
  successful sync) and shown on the card:
  **⚠ agentclaw-ai didn't sync — The repo rejected this agent's deploy key…**
  with a **🔑 Deploy key** button that opens the Data tab and, for GitHub, links
  straight to that repo's *Add deploy key* page.
- Raw git/ssh stderr is translated into the actual fix (`gitSyncReason`):
  "Permission denied (publickey)" becomes "The repo rejected this agent's deploy
  key — add it to the repository (Settings → Deploy keys), then rebuild."
  Repo-not-found, host-key, and network failures get their own wording;
  anything unrecognised keeps git's own words, bounded.

## [0.55.0] — 2026-08-27

### Added
- **Change a data source between read-only and writable, in place.** There was
  no way to flip access after adding a source — the only route was remove and
  re-add, which for a git repo meant a fresh clone **and a new deploy key to
  paste on GitHub**. Each source now has a one-click toggle
  (`PATCH /v1/agents/:id/data-sources/:dsId`), keeping the same row, clone, and
  key. Applies on the next rebuild, since a container's bind mounts are fixed
  once it's running. Granting write to a *host folder* stays the machine
  owner's privilege (same gate as creating one); going back to read-only is
  always allowed.
- **Agents are now told where their data actually is.** AgentClaw maintains a
  `## Data sources` section in each agent's `AGENTS.md`, listing every repo and
  folder with its **real in-container path** and whether it may be written —
  refreshed on every provision and rebuild. Adding a repo used to drop the files
  on the volume and leave the agent with no idea they existed; you had to
  describe the paths by hand. Only that one section is managed; the rest of the
  file stays yours (same technique as the memory-policy section), and the
  rewrite is idempotent.

  For reference, git repos are checked out at `/home/node/.openclaw/<repo>` and
  folders mount at `/data/<name>` (adopted agents keep their original host path).

### Note
- For a **git** source, read-only vs writable is a statement of intent the agent
  is told about — the repo is cloned onto its own volume, so whether a *push* is
  accepted is governed by the deploy key's permission on the repo host, which
  AgentClaw doesn't control. For a **folder** it's enforced by the bind mount.

## [0.54.0] — 2026-08-27

### Added
- **Turn a join request away ("Not now").** Until now the only answer to
  "someone wants to talk to this agent" was **Let them in** — ignoring it left
  the request (and its 👤 badge) pending until OpenClaw expired it. Added a
  **Not now** button on the card and a **🚫 Not now** button on the management
  bot's approval push, backed by `POST /v1/agents/:id/pairing/deny`.

  OpenClaw's CLI has `approve`/`list` but **no deny verb** (verified against
  2026.7.1), so this is an atomic surgery on the on-volume pairing store
  (`credentials/telegram-pairing.json`, kept 0600) — the same technique
  `revokeMember` already uses for the allowlist, and it works on a stopped agent
  too. A test runs the real emitted script against a real file to prove it
  removes exactly the named request and leaves the rest of the store intact.

  It is deliberately **"not now", not a ban**: the person can ask again by
  messaging the bot, and every surface says so.

### Changed
- The approval push's second button is now a real **🚫 Not now** (it previously
  only dismissed the notification without answering the request).

## [0.53.0] — 2026-08-26

### Added
- **"Someone's waiting" badge in the table of contents.** An agent with a
  pending join request now shows a softly-pulsing 👤 badge (with a count when
  more than one) next to its name in the legend, so you can see at a glance
  which agent needs you without scrolling the cards. Clicking jumps straight to
  that card's "wants to talk" prompt. It's driven by the same live pairing poll
  the cards use, so it clears itself as soon as the request is approved. Honors
  `prefers-reduced-motion`.

## [0.52.0] — 2026-08-26

### Changed
- **The agent legend is now a permanent table of contents, not a button-toggled
  menu.** On screens ≥1200px it's pinned to the upper-left and always visible —
  the page reserves a gutter for it, so it never covers a card, and being
  `position: fixed` it stays put while you scroll the cards. The 📑 Jump button
  is now only a fallback on narrow screens (where there's no room for a gutter),
  which keep the on-demand overlay that closes itself after a jump.

## [0.51.1] — 2026-08-26

### Fixed
- **Copy buttons now work over plain HTTP** (e.g. `http://<tailscale-host>:8080`).
  `navigator.clipboard` only exists in a secure context (https / localhost), so
  every Copy button — the new "Copy Telegram invite", plus web link, CLI token,
  bot token, and runner-setup snippet — silently did nothing over a plain-HTTP
  tailnet URL. Added a shared `copyText()` helper with a hidden-textarea
  `execCommand` fallback and routed all copy actions through it; each now
  reports success or tells you to select-and-copy when even the fallback is
  blocked.

## [0.51.0] — 2026-08-26

### Added
- **Invite people through Telegram — no Tailscale needed.** The web `/join`
  link requires the invitee to reach the control plane over your tailnet. That
  was never actually necessary for chat access: an invitee can just message the
  agent's bot and be admitted. This makes that path first-class:
  - **Invite dialog** now leads with the Telegram invite — a ready-to-send
    message ("Chat with <agent> on Telegram: <link>"), a native **Share…**
    button, and the QR — with the web link demoted to a secondary "needs
    Tailscale, but grants web login" option.
  - **Approval push (management bot):** when an invitee messages one of your
    agents' bots, your management bot now DMs you a one-tap **✅ Approve /
    ✕ Dismiss** card the moment it happens — no more watching the web UI for a
    "wants to join" card. Approving admits them (allowlists their Telegram id,
    binds the membership, sends the welcome). The one-tap approve is a
    deliberate, per-person action, so it works even in read-only mode; it still
    respects `/pause` and the change rate limit.
  - New `GET /v1/pending` (all pending join requests across your RUNNING agents,
    owner-scoped), a background poller in the mgmt bot (`notifier.ts`), and a
    shared `kickRebuild`-style one-tap `broker.approveJoin`.

  Fully automatic "click link → joined" still isn't possible — OpenClaw's
  pairing metadata exposes the sender's name/username but not a `/start`
  payload — so approval stays a one-tap step.

## [0.50.0] — 2026-08-26

### Added
- **Jump-to legend (table of contents) for the agent list.** A new **📑 Jump**
  button in the header (shown once you have 2+ agents) toggles a fixed
  upper-left panel listing every agent — grouped and ordered exactly like the
  main list, each with a state dot (running / stopped / failed / working).
  Clicking a name smooth-scrolls to that agent's card and briefly highlights it.
  Opens by default on wide screens (where it clears the centered content
  column); on narrower windows it opens on demand as an overlay and closes
  itself after you jump.

## [0.49.0] — 2026-08-26

### Changed
- **The "switch agents to <model>" dialog now names the source it's scoped to.**
  It only ever lists your agents on the one AI source whose default you changed,
  but the wording didn't say so — an agent on a *different* source (e.g. one on
  a separate API-key source while the rest are on your Max subscription) looked
  like it was missing. The dialog now says "Only your agents on **<source>** are
  listed — agents on your other AI sources aren't affected."

## [0.48.0] — 2026-08-26

### Added
- **Choose which agents adopt a new default model — "select agents, hold the
  rest".** Changing a cloud source's default model used to silently queue every
  following agent to switch on its next rebuild. Now, when you change the
  default on a source that has agents, a dialog lists them: ticked agents switch
  to the new model (and optionally rebuild now), and **every un-ticked agent is
  pinned to the model it runs today** so it never silently drifts. Agents that
  have their own chosen model start **un-ticked and protected** — they only
  switch if you explicitly tick them. Backed by a new atomic endpoint
  `POST /v1/ai-profiles/:id/apply-default-model` that sets the default, clears
  the override on selected agents, pins the rest (keeping their models on the
  source menu so the pins stay valid), and kicks background rebuilds for the
  selected ones. Only your own agents are touched — a shared source never
  reaches into another user's agents. Local sources (one model per GPU) keep the
  plain set-default-and-rebuild flow.

### Changed
- Factored the background rebuild kick into one `kickRebuild` helper, now shared
  by the per-agent rebuild route and the model-apply fan-out.

## [0.47.0] — 2026-08-26

### Changed
- **The bot-pool chip now always shows, reading "0 instant bots ready" when
  the pool is empty** instead of disappearing. The dot goes muted (from green)
  at zero, so an empty pool is a visible state rather than a missing one.

## [0.46.0] — 2026-08-26

### Added
- **Edit an agent's description after creation.** The description entered at
  create (the card's one-liner, stored as the agent's persona) had no edit
  field afterward — Settings → Definition only exposed the name, memory policy,
  and the raw SOUL/AGENTS/MEMORY files. Added a **Description** field to the
  Definition tab: it PATCHes the stored persona, applies immediately (it's the
  card label, no rebuild), and an empty value clears it. Clearly marked
  cosmetic — to change how the agent behaves you still edit SOUL.md, which sits
  right below it. `PATCH /v1/agents/:id` now accepts `persona`; new
  `store.setAgentPersona`.

## [0.45.0] — 2026-08-26

### Changed
- **Rebuild responds instantly instead of stalling for seconds.** The
  pre-rebuild snapshot (a ~1–2s `docker exec` per agent) ran *synchronously in
  the request* before `POST /rebuild` returned, so "Rebuild all" fired the
  calls one-by-one and sat visibly silent while each agent snapshotted. Moved
  the snapshot to be the first step of the background rebuild task: the POST
  returns `202` immediately, the card flips to **REBUILDING** right away, and
  the snapshot still runs while the agent is RUNNING and before the container
  is stopped/replaced (verified by test). The web "Rebuild all" also shows an
  immediate "Queuing N rebuilds…" toast so the row never sits blank.

## [0.44.0] — 2026-08-26

### Changed
- **Moved the "N instant bots ready" indicator** out of the cramped spot beside
  the AgentClaw logo into the actions row (right-aligned), styled as a quiet
  capacity chip with a green dot. It now hides entirely when the pool is empty
  instead of leaving a gap, and its tooltip points to ⚙ Settings → Bot pool.

## [0.43.0] — 2026-08-26

### Added
- **Estimated API cost column on the fleet usage rollup.** Each agent and the
  fleet total now carry a dollar estimate next to the token count, in both the
  📊 Usage dialog and `agentclaw usage`. It's honest about its limits: only
  API-keyed agents have a per-token cost (subscription/Max agents show
  "included", local agents "local", both $0), and because OpenClaw reports one
  combined input+output counter with no split, the figure is a **range** — the
  low bound prices every token as input, the high bound as output (for
  agent workloads, where reloaded context dwarfs output, the true cost sits
  near the low end). A shared price table (`src/orchestrator/pricing.ts`, kept
  in sync with the web app's) is the source of truth; unknown models are
  flagged with a trailing `+` rather than silently priced at zero. The route
  (`GET /v1/usage`) computes it server-side from each agent's per-model
  breakdown, so the web and CLI agree.

## [0.42.0] — 2026-08-26

### Added
- **Fleet usage rollup — see which agents burn the most tokens at a glance.**
  A new **📊 Usage** button in the header opens a dialog that ranks every
  running agent by cumulative tokens (input + output), with a bar, session
  count, last activity, and billing context (included / local / API price) per
  agent. On the CLI, `agentclaw usage` with no agent name prints the same
  ranked table (`agentclaw usage <agent>` still gives one agent's by-model
  breakdown). Backed by `GET /v1/usage`, which fans out `agentUsage()` across
  the caller's visible running agents and sorts by tokens. **Live-only:** usage
  is read from each live container, so stopped agents aren't counted — they're
  reported as "N not counted (live-only)" rather than shown as zero. One
  unreachable container drops to the skipped count instead of sinking the whole
  list. Scoped to the caller's own agents like every other list.

## [0.41.0] — 2026-08-26

### Fixed
- **Adopt now carries a cron's delivery route — no more "no route" failures
  or leaked isolated replies.** Migrated crons dropped the source's delivery
  target (`session_target` / `delivery_mode` / `delivery_channel` /
  `delivery_to`), so OpenClaw fell back to `announce → last`: an isolated cron
  fail-closes ("Refusing implicit isolated cron delivery… set delivery.channel
  and delivery.to explicitly"), and when it *does* route, the agent's chatty
  final reply ("the message tool isn't available here…") lands in whatever
  chat you talked to last. `readOpenclawCrons` now reads the delivery columns
  (when present) and `cronAddArgs` emits `--session/--announce/--channel/--to`,
  so an adopted cron reaches the same chat it did before. The live fleet's
  affected crons (condo + gf advisers) were repointed to explicit Telegram
  delivery in place.

## [0.40.0] — 2026-08-25

### Fixed
Audit Wave 2 — the cheap/medium findings (Wave 1 in 0.39.0 covered the
data-loss critical + high):

- **gog binary now checksum-pinned** in the runtime image (per-arch sha256,
  verified before extract) — a mutated upstream GitHub release can't silently
  ship into the image every agent's Gmail/Drive creds live in.
- **Pool usernames are case-insensitive** (`COLLATE NOCASE` + lowercase on
  add) — an adopt-sourced bot differing only in case can no longer create a
  duplicate pool row (which would have meant two leases → two pollers).
- **Migrating a pool bot no longer leaks its slot** — the local pool row is
  retired (token scrubbed, count freed) instead of lingering leased-forever,
  and it's never freed for re-lease (which would hand the same token, now on
  the peer, to a new local agent).
- **The fleet media key is labeled a shared credential** in the UI — it's
  injected into every agent, so an agent owner can read it; the copy now says
  so and recommends a purpose-scoped key.
- **`agentclaw list` PATCH profile-switch** now allows a setup-token Max
  source onto a runner agent (matching create/move).
- **Hardening**: input validation on media-key / pool / move-host bodies (bad
  input → 400, not 500); drain holds the busy flag per agent (no stop mid-tar);
  `GET /v1/hosts` shows a non-admin only their own agent counts; doctor-lint
  reports `ok:undefined` from garbage output instead of a false green and mutes
  the plaintext-secrets warning by message (not the whole security check);
  `importState` validates the archive (`gzip -t`) before clearing the volume;
  the SSH-config marker matches a whole line (no `vm`/`vm2` prefix collision);
  `parseSshEndpoint` rejects whitespace standalone; a cosmetic double-escape.

### Backlog (recorded, not fixed)
`authorized_keys` command-restriction, `tcp://` TLS gating, unbounded
remote-daemon output buffering + per-op timeouts, capability-cache staleness
after an in-place image upgrade, probe-container sandboxing — see the audit
backlog memory.

## [0.39.0] — 2026-08-25

### Fixed
Security/robustness audit (v0.26→v0.38 delta, 5 parallel reviewers). No
cross-user leak, XSS, or injection found; the auth model and escaping are
sound. Wave 1 — the data-loss / data-integrity findings:

- **Move-to-host could destroy the agent it just moved.** The "don't purge
  the source" guard compared endpoint *strings*, so two host rows for one
  daemon under different endpoints (`ssh://h` vs `ssh://h:22`, IP vs
  hostname, a runner aliasing localhost) — or a local↔runner-same-box move —
  slipped past and `docker volume rm -f`'d the live volume. Now the move
  compares real **daemon identity** (`docker info` ID) and refuses if they
  match (or if a daemon can't be reached — "can't verify" never green-lights
  a purge). `RuntimeProvider.daemonId()` added.
- **Move rollback could leave two pollers on one bot.** A correlated failure
  (hung remote daemon fails both the health check and the cleanup) left the
  target container running while the source restarted. Rollback now confirms
  the target is actually gone before restarting the source; if it can't, it
  leaves the agent STOPPED with a clear message instead of dual-polling.
- **Move wasn't crash-safe.** `hostId` was persisted to the target before the
  volume data landed, so a crash mid-move made Retry seed a fresh empty agent
  on the target while the real memory sat orphaned on the source. The hostId
  flip now happens only after `importState` succeeds (`buildRuntimeSpec` takes
  a host override so the target spec builds without a premature store write).
- **Pool/manual resume hijack.** An agent that opted out of the pool (or hit
  an empty pool) and parked awaiting a pasted BotFather token could, on
  resume, be bound to a *pool* bot instead — silently reversing the user's
  choice and stranding their token. The composite now gives a pending pasted
  token precedence over an available pool bot.

## [0.38.0] — 2026-08-25

### Changed
- **The bot pool is now ownership-aware.** A bot token belongs to whoever
  minted it at BotFather — they can rename or revoke it any time — so one
  user's recycled bot must never silently become another user's next agent
  identity (it did: the pool was server-scoped). Now each pool bot carries
  an owner; leasing offers a user their *own* bots first, then **shared**
  house bots (an explicit "Share with everyone" choice when stocking, and
  the admin script's default). Recycle-on-delete parks the bot under the
  deleting agent's owner; the "N instant bots ready" count is per-user; the
  pool roster labels each bot yours / shared / another user's. Existing
  pool rows migrate as shared.

## [0.37.2] — 2026-08-25

### Added
- **`agentclaw list --all` — the host owner's admin view.** Lists every
  user's agents with their owner id (`GET /v1/agents?all=1`, host-owner
  only), so leftovers from another login — an old test Google account's
  agents holding bots and containers — are findable. Metadata only:
  memory, files, and conversations stay behind per-agent ownership as
  always.

## [0.37.1] — 2026-08-25

### Added
- **The Runtime tab lists what agents can do.** A "What agents can do"
  section shows the base image's key capabilities — agent runtime, Claude
  Code, web search (DDG), memory search (local), voice notes (live status of
  the Gemini media key), Google Workspace via gog, Python, Git+SSH — each
  with its probed version, plus an honest "not included" line (ffmpeg /
  whisper / chromium: no local audio processing or browser automation, by
  design). Tool versions are **probed live from the image** (one-shot
  container, cached per tag; `GET /v1/runtime/capabilities`, host-owner
  only) so the list can't drift from reality.

## [0.37.0] — 2026-08-25

### Added
- **Voice notes work again — fleet media key.** On the manual OpenClaw
  install, voice worked because the gateway loaded a `GEMINI_API_KEY`
  (OpenClaw transcribes inbound audio by sending it to an audio-capable
  model); containers never got that key, so AgentClaw agents were deaf. New
  **Voice & media understanding** section in ⚙ Settings → AI sources: paste
  one Gemini API key (free tier available) and every agent gains voice-note
  transcription on its next Rebuild. The key is stored write-only
  (`GET/PUT/DELETE /v1/media-key`) and injected by provisioning itself —
  the Environment tab deliberately reserves `GEMINI_*`, so this is the
  managed path; a google-vendor AI profile's own key still wins per agent.
- Follow-up recorded (docs/connections-design.md): **runtime image
  variants/marketplace** — per-agent images (base / media / data / browser)
  instead of one kitchen-sink image.

## [0.36.1] — 2026-08-25

### Fixed
- **Memory search was silently dead fleet-wide — now on the keyless local
  model.** The doctor-lint sweep's first real catch: OpenClaw's memory-search
  default points at OpenAI embeddings, which no AgentClaw agent has a key
  for, so semantic recall over MEMORY.md never worked. Provisioning now sets
  `agents.defaults.memorySearch.provider local` (bundled embedding model, no
  key, no network at query time), and the whole running fleet was switched
  in place (no restarts needed).

## [0.36.0] — 2026-08-25

### Added
- **Config lint in the health system — silent degradations now surface.**
  "Web search is not available" went unnoticed because a gateway can be
  perfectly healthy while a capability is quietly off. The health probe can
  now also run `openclaw doctor --lint --json` (read-only, ~4s):
  `GET /v1/agents/:id/health?doctor=1`. The Fleet Health **Run health
  checks** sweep requests it and shows a **⚠ N config warnings** marker per
  agent (tooltip: the findings); the per-agent ❤️ Health dialog lists each
  finding, or "N checks clean". Warnings true of every AgentClaw agent by
  construction (doctor's plaintext-config-secrets family) are counted but
  muted, so real signal isn't buried by permanent noise.

## [0.35.1] — 2026-08-25

### Fixed
- **"Web search is not available" — real web search enabled for every agent.**
  OpenClaw's stock DuckDuckGo search provider ships disabled, so the
  `web_search` tool honestly reported "not available" while agents quietly
  answered from model knowledge (plus `web_fetch`, which needs no provider) —
  convincing, but ungrounded for anything recent. Provisioning now runs
  `plugins enable duckduckgo` (free, keyless) for every agent, and the whole
  running fleet was enabled + restarted in place. Owners wanting
  higher-quality search can add a `BRAVE_API_KEY` in the agent's Environment
  tab and enable the Brave provider — a keyed provider outranks the DDG
  fallback.

## [0.35.0] — 2026-08-24

### Added
- **Connections, phase 1: Google Workspace via `gog`** (per
  `docs/connections-design.md`). The runtime image now ships the `gog` CLI
  (one static binary); every agent workspace seeds a `skills/gog/SKILL.md`
  teaching the **chat-based connect flow** (`gog auth add --remote` —
  the agent prints Google's consent URL, the owner approves on their phone
  and pastes the code back; no browser on the server). `GOG_HOME` points at
  the agent's own volume, so credentials refresh in place and ride Move,
  backups, and Download — and Share templates never include them. The skill
  bakes in the guardrails: owner-only setup, purpose-bound accounts,
  minimal `--services`, confirm-before-send. Seed script now handles nested
  seed files (`skills/…`) with the overwrite guard intact. Image rebuilt,
  e2e-smoked, and promoted; existing agents pick it up on Rebuild.

## [0.34.1] — 2026-08-24

### Changed
- **Deleting an agent parks its bot in the pool by default** — no extra
  question. Bots are the scarce resource (Telegram's per-account ceiling), so
  every delete keeps the token: the confirm dialog says where the bot goes,
  the toast confirms it, and ⚙ Settings → Bot pool is where a token gets
  discarded on purpose. API: `DELETE /v1/agents/:id` recycles unless
  `?recycleBot=0`; recycling is best-effort end to end and can never block a
  delete.

## [0.34.0] — 2026-08-24

### Added
- **A recycled bot renames itself to its next agent.** When the pool leases a
  bot, AgentClaw now sets the bot's Telegram display name to the new agent's
  name (`setMyName`) — so the chat header reads "Art Test", not whatever the
  last agent was called. Best-effort and bounded: a Telegram rate limit or
  outage never blocks provisioning; the @username stays (Telegram doesn't
  allow changing it via API — BotFather can, by hand). The recycle prompt's
  tip now mentions it.

## [0.33.1] — 2026-08-24

### Added
- **Choose pool-or-bespoke at creation.** When the bot pool has bots, the
  create dialog shows a checked-by-default "Use a ready bot from the pool
  (N ready)" checkbox — uncheck it to walk BotFather and mint a bespoke
  @handle for this agent instead. With an empty pool there's no choice to
  offer, so the row is hidden. (`skipPool` on `POST /v1/agents`, honored by
  the channel provisioner before the pool is ever consulted.)
- Both Settings dialogs widened for their grown tab bars.

## [0.33.0] — 2026-08-24

### Added
- **The bot pool is now a first-class feature** (⚙ Settings → Bot pool).
  Stock it from the app: paste a BotFather token, it's verified with Telegram
  and parked; creation grabs a pool bot instantly when one is available, and
  the roster shows each bot as available or in use (Remove for unleased
  ones). Deleting an agent whose bot you pasted by hand now **offers to park
  the bot in the pool** instead of forgetting its token — with Telegram's
  ~20-bots-per-account ceiling, every recycled slot counts. New
  `GET/POST /v1/pool`, `DELETE /v1/pool/:username`,
  `DELETE /v1/agents/:id?recycleBot=1`; the agent list carries
  `botUsername`/`botPooled` so the app knows which delete flows to offer.
- **Agents know which machine they run on.** The container hostname is now
  `<agent>.<host>` and `AGENTCLAW_HOST_NAME` carries the host's human name —
  both re-rendered on every rebuild and Move, so asking an agent "where are
  you running?" in Telegram gets a true, current answer as it hops machines.

## [0.32.0] — 2026-08-24

### Added
- **Adding a runner is now a guided, mostly-automatic flow.** The form used to
  ask for an SSH address while silently assuming seven hand-done steps (key
  generation, key install, ssh-config, known-hosts, PATH fix, runtime image).
  Now: the control plane generates and manages a **dedicated runner key**
  (`~/.ssh/agentclaw_runner`, passphrase-less, pinned per host in
  `~/.ssh/config` with `IdentitiesOnly` + `accept-new` so the headless
  service authenticates deterministically); the Runners tab shows a
  **paste-once snippet** for the runner side (authorizes the key, fixes the
  macOS non-interactive PATH quirk, self-checks docker); and reachability
  pings also check for the **runtime image**, with an **Install image**
  button that streams this box's image over (`docker save | docker -H load`).
  New `GET /v1/runner-setup` and `POST /v1/hosts/:id/install-image`;
  `src/orchestrator/runnerSetup.ts` with tests. Deep-dive doc:
  `docs/runner-setup.md` (includes the troubleshooting table learned on the
  first live runner).
- **`docs/features.md` — a consolidated feature tour.** One task-first page
  covering create/talk, training & memory, copy & move, adopting OpenClaw
  agents, data & secrets, members & invites, fleet operations, backups, AI
  sources, the bots census, CLI + management bot, and the smoke test — with
  links into the deeper docs. Linked from the README.

## [0.31.2] — 2026-08-24

### Changed
- **A moving agent now LOOKS like it's moving.** A Move takes about a minute,
  during which the card used to sit at STOPPED — easy to read as "it broke".
  The API now reports a `busy` flag whenever an agent is mid-operation (move,
  backup, export, adopt…), the status chip shows a pulsing **WORKING…** for
  the duration, the app fast-polls (2.5s) while any agent is busy, and the
  Move / move-to-cluster toasts got a louder ⏳ progress style that says the
  card will show WORKING until it's done.

## [0.31.1] — 2026-08-24

### Changed
- **Snapshots get their own tab** in the agent's ⚙ Settings dialog, out of
  Definition — with room to breathe (taller list) and copy explaining what a
  snapshot covers and when they're taken automatically.

## [0.31.0] — 2026-08-24

### Changed
- **One ⚙ Settings button per agent, five focused tabs.** The card's separate
  📖 Definition and ⚙ Configuration buttons collapsed into a single
  **⚙ Settings**, and the old Configuration junk-drawer split into its own
  tabs: **Definition** (name, persona, memory, snapshots), **AI** (source +
  model), **Data** (folders & git repos), **Telegram** (the bot token,
  with copy explaining it *is* the agent's identity), and **Environment**
  (per-agent env vars, with copy explaining what they're for: credentials the
  agent's *own* tools read — a market-data key a script calls, not the AI
  credential — and that most agents need none).

## [0.30.2] — 2026-08-24

### Changed
- **Terminology pass — the UI now speaks Cluster/Mesh consistently.** "Host",
  "server", and "Rehost" had drifted into ambiguity as Cluster grew:
  - Settings **Hosts** tab → **Runners** (the machines this cluster runs
    agents on; "this machine" is the built-in runner). Fleet Health tile
    renamed to match.
  - Settings **Servers** tab → **Cluster servers** (other AgentClaw control
    planes — each its own cluster), with copy that points people wanting more
    machines under *this* dashboard at Runners instead.
  - **Rehost** → **"Move to another cluster"** (card ⋯ menu), with dialogs
    reworded to say the agent is managed from that server's dashboard
    afterwards.
  - **Access** tab copy now names both uses of a token: the CLI, and
    connecting two cluster servers.
  API routes and CLI commands keep their names — no breaking changes.

## [0.30.1] — 2026-08-24

### Changed
- **Card cleanup: Download and Rehost moved into the ⋯ menu.** Both are
  occasional actions now — server-side Backups cover routine safety copies,
  and intra-cluster **Move** is the everyday relocation path — so the main
  button row keeps only the frequent verbs. They live on as "Download copy"
  and "Rehost to another server" in the card's overflow menu.

## [0.30.0] — 2026-08-24

### Added
- **Move to host — relocate an agent within the cluster.** A new **Move**
  button on the agent card (shown when more than one host exists) moves an
  agent between hosts on this server: local → runner, runner → local, or
  runner → runner. Same agent record, same bot, same members — the flow
  quiesces the agent, snapshots its volume through the source daemon,
  recreates and restores it on the target, starts it there, then retires the
  source runtime. Any failure before the target is healthy rolls the agent
  back onto its original host. Unlike Rehost (the Mesh move to another
  AgentClaw *server*), there is no tombstone and no second-poller risk.
  New `POST /v1/agents/:id/move-host` + `src/orchestrator/moveHost.ts`;
  guards: Max machine-login profiles can't move to a runner (setup-token ones
  can), and two host rows pointing at one Docker endpoint are refused. Tests
  cover the cross-daemon copy, stopped-agent moves, rollback, and the guards.

### Changed
- **Agent cards always name their host.** The status line now reads
  `model · on <host> · active …` for every agent — "on this machine" locally,
  the runner's name in Cluster mode — instead of only mentioning non-local
  hosts.

## [0.29.0] — 2026-08-24

### Changed
- **Claude Max can run on a runner — via a setup-token.** A subscription profile
  is no longer refused on every non-local host; the gate now distinguishes the
  two credential flavours. A **machine-login** subscription (this box's
  `~/.claude`) stays local, because that mount can't reach a remote daemon. A
  **setup-token** subscription (`claude setup-token`, stored) is injected as
  `CLAUDE_CODE_OAUTH_TOKEN` and now provisions on a **runner** too — so a laptop
  driven by another box's control plane can serve agents on your own Max login.
  Guard updated at both the create API and provision (`routes.ts`,
  `provision.ts`); the create dialog's "Runs on" hint and the Hosts panel now
  say Max-setup-token is allowed on a runner (the machine-login source stays
  desktop-only). Docs updated (`ai-profiles`, `cloud-hosting`, `topologies`,
  `deploy-gce`). New tests cover both flavours at the route and provision layers.

## [0.28.0] — 2026-08-24

### Added
- **Fleet ops for Cluster mode.** The Hosts tab and the Fleet Health dashboard
  now show each runner's live reachability, and a runner with agents has a
  **Drain** button that stops every running agent on it (take it out of service
  before decommissioning). New `POST /v1/hosts/:id/drain` and
  `GET /v1/hosts/:id/ping`; the hosts list reports `agentCount`.
- **One-command smoke test:** `npm run smoke` (or `./scripts/smoke.sh`) runs the
  full isolated adopt smoke, auto-loading `.env.smoke`.

### Fixed
- **Google sign-in ignored your theme.** The button was hardcoded to the dark
  (`filled_black`) style, so a light install got a black button — it now follows
  the app theme (and `prefers-color-scheme` on the join page).
- **The agent card status line is consistent again.** It crammed container name,
  model, OpenClaw version, shared-memory, activity, warm/cold, and data into one
  ragged chain whose order shifted per card. It's now a fixed-order line of only
  the true facts (model · runner · active · warming · data · shared memory), with
  the container name / OpenClaw version moved to the hover tooltip.

## [0.27.0] — 2026-08-24

### Added
- **Fleet health dashboard** (📊 Health in the header). One glance at the whole
  fleet: counts (running / stopped / failed / working), a **"needs attention"**
  list (failed agents with their reason, agents waiting for a bot, and running
  agents idle >14 days), and a per-agent status line with state, model, and last
  activity. For the host owner it also shows **backup health** (latest set + age,
  warns when >2 days old or missing the decryption key) and **runtime** (image
  version / upgrade available). A **Run health checks** button probes each
  running agent's in-container gateway on demand and paints a live dot. Built
  entirely over existing endpoints — no new server surface.

## [0.26.0] — 2026-08-24

### Fixed
Fourth deep audit (5 parallel agents over the 0.18→0.25 delta: transfer/backups,
adopt/OpenClaw import, API auth, store/provision/bots, web/CLI). No critical,
high, or XSS found — the auth model and escaping are sound. Fixed findings:

- **`agentclaw bots --check` no longer flags a live agent's bot `DEAD` on a
  transient Telegram blip.** `getMe` is now status-aware (only 401/404 = invalid;
  5xx/network/timeout = unknown), never downgrades an in-use bot, and both census
  probes carry a 5s timeout so one hung endpoint can't stall the whole census.
- **Adopting into a STOPPED agent** no longer hangs ~30s probing a down gateway
  and mislabeling every cron "failed" — it reports them `deferred` instead.
- **`quiesce` is now atomic**: it validates every account id before writing, so a
  bad id can't leave bots disabled-in-config yet still polled (a silent
  split-poll), and writes one backup + one config write for the batch.
- **Batch adopt quiesces every selected bot**, not only ones still enabled — a
  "disabled but never gateway-restarted" bot no longer gets taken over while
  OpenClaw still polls it.
- **Restore/rollback now truly replaces the volume** instead of overlaying —
  files created after a backup are removed, so "restore to a known-good state"
  holds (`importState` clears the volume before extracting).
- **Import caps the archive state** the way export already does, and
  `parseTemplate` gunzips under a bound with a file-count cap.
- **Busy-guards added** to the two volume-writing routes that lacked them
  (`PUT …/files/:name`, memory-policy `PATCH`), and the adopt path-rewrite + cron
  migration now run inside the busy guard.
- Hardening: schema migrations rethrow anything but "duplicate column"; the
  gateway-port env is validated (no `NaN`); `findAgentUsingAccount` matches
  account ids case-insensitively (`COLLATE NOCASE`); the data-folder scan skips
  hidden/credential dirs (`.ssh`, `.aws`, …); a pathological `/` path can no
  longer corrupt a cron/file rewrite; backup buttons escape args with `jsq`.

## [0.25.1] — 2026-08-24

### Fixed
- **`findExistingBot` now honors `OPENCLAW_CONFIG`.** The reuse-bot path
  (`channel-token` with `fromWorkspace`) read a hardcoded `~/.openclaw/openclaw.json`
  while discovery honored the `OPENCLAW_CONFIG` env — so on an install with a
  non-default OpenClaw config, adopt could discover an agent's bot but then fail
  to take it over ("No existing Telegram bot is bound to …"). Both read the same
  config now. (Surfaced by the isolated adopt smoke harness.)

## [0.25.0] — 2026-08-23

### Added
- **Adopt rewrites the agent's own paths to the container.** An OpenClaw agent's
  files and crons reference its hand-built workspace/agentDir by absolute path
  (`/home/you/.openclaw/workspace-x/…`); inside the container that content lives
  at `/home/node/.openclaw/agents/<slug>/agent`. Adopt now repoints those
  references — a fixed-string pass over the copied workspace files (run via
  `node` in the container) and over each migrated cron's message — so schedules
  and prompts resolve instead of pointing at a path that isn't there. Longest
  path first (agentDir before its parent workspace); external data paths are
  untouched (those are handled by folder shares). Best-effort — never fails the
  adopt; skipped only for a shell-hostile path.

## [0.24.1] — 2026-08-23

### Fixed
- **Cron migration waits for the container's gateway before adding jobs.**
  `applyWorkspace` restarts the container but doesn't wait for OpenClaw inside it
  to come up, so `cron add` could race the boot and silently drop jobs. Migration
  now polls a harmless `cron list` until the gateway answers, then adds — and
  reports the jobs as failed (not lost) if it never becomes ready.

## [0.24.0] — 2026-08-23

### Added
- **Adopt carries the agent's scheduled tasks (crons).** OpenClaw keeps crons in
  its global gateway DB, not the workspace, so the file copy left them behind.
  Adopt now reads the source agent's jobs straight from that DB and recreates
  each inside the new container via the same in-container `openclaw cron` CLI —
  brought in **disabled**, so you review (and fix any stale paths/delivery)
  before they fire. Best-effort: a cron hiccup never fails the adopt. The count
  is reported in the adopt toast and per-row in a batch.
  - Reads `~/.openclaw/state/openclaw.sqlite` (override `OPENCLAW_STATE_DB`),
    resolving the source agent from the workspace path. `adopt-workspace` returns
    a `crons` summary. All 18 of a real fleet's jobs are cron-schedule +
    agent-message, which map cleanly; `every`/`at`/`command` are handled too.

## [0.23.0] — 2026-08-23

### Added
- **Adopt offers to share the data folders an OpenClaw agent depends on.**
  OpenClaw agents can read the whole filesystem; AgentClaw agents are boxed in a
  container. After an adopt (single or batch), the workspace is scanned for
  absolute host paths it references that exist and sit outside the workspace
  (e.g. `/home/you/taxes/2026/reports`), and you're offered to share them
  read-only. Crucially they bind at their **original host path** inside the
  container — via a new "mount at host path" option on folder shares — so the
  agent's existing references (in prompts, memory, and crons) resolve unchanged
  instead of breaking on a `/data/<name>` remap.
  - New `POST /v1/workspaces/scan-paths` (host-owner-gated); `data_sources`
    gains a `mount_at_host_path` flag; `POST …/data-sources` accepts `atHostPath`.
  - The scan is conservative: it skips the OS, `.openclaw`'s own state, the
    agent's own workspace, missing paths, and trims trailing prose punctuation,
    then collapses nested hits and files-to-their-folder.

## [0.22.1] — 2026-08-23

### Fixed
- **Discovery now recognises an already-imported OpenClaw agent even when its
  bot was relabelled.** It matched on the OpenClaw config's account key, but that
  key is a user-chosen label — the real Telegram @username (what AgentClaw stores)
  can differ (e.g. `lgfgghllbot` vs `LgFgGhIlBot`). It now matches on the bot
  token's id, the bot's true identity, so a brought-in agent is correctly shown
  as already in AgentClaw regardless of labels.

## [0.22.0] — 2026-08-23

### Added
- **Discover and batch-import your OpenClaw agents.** The adopt dialog now lists
  every OpenClaw agent installed for the user this server runs as (read from
  `~/.openclaw/openclaw.json`), each annotated with its bot and whether it's
  already in AgentClaw. Tick the ones you want and **Bring in selected** copies
  them all — no hunting down workspace paths.
  - **Automatic bot hand-over.** For a selected agent whose bot is still live in
    OpenClaw, the tool disables it in the config (backing the file up first) and
    restarts the gateway **once** for the whole batch, verifies each bot went
    quiet, then takes it over — the manual "disable AND restart" step is gone.
  - New `GET /v1/openclaw/agents` (discovery) and `POST /v1/openclaw/quiesce`
    (disable + one gateway restart + verify), both host-owner-gated. Every config
    write leaves a `.agentclaw-bak` beside the original. The gateway unit is
    `openclaw-gateway` (override with `AGENTCLAW_OPENCLAW_GATEWAY_UNIT`).
  - The single manual-path adopt is unchanged, tucked under "Or point at a
    workspace folder manually"; both flows share one core.

## [0.21.4] — 2026-08-23

### Fixed
- **Multi-line command blocks (`.invite-link`) collapsed onto one line.** The
  hand-over steps in the adopt dialog put the two `openclaw`/`systemctl` commands
  on separate lines, but the element's default `white-space` folded the newline
  into a space — so they ran together and couldn't be pasted as-is. Added
  `white-space: pre-wrap`; single-line uses (tokens, invite URLs) are unchanged.

## [0.21.3] — 2026-08-23

### Fixed
- **Web adopt gave a dead-end error when the workspace's bot was still live.**
  Disabling a bot in OpenClaw's config doesn't stop its gateway from polling
  until the gateway restarts, so the poll probe saw it busy and hid "Take over
  its bot" — then "Bring it in" failed with a generic "needs a bot". It now names
  the bot and the exact two-step fix (disable AND restart the gateway, then
  Inspect again).

## [0.21.2] — 2026-08-23

### Added
- **`agentclaw bots` now numbers each line and flags shared bots.** A handle that
  appears in more than one place — the same bot on two hosts, or reused by a
  different agent — gets a `⇄ also …` marker pointing at the other occurrences,
  which surfaces rehost/adopt leftovers (e.g. an agent left STOPPED on the old
  host still bound to a bot the new host now polls). The summary counts them.

## [0.21.1] — 2026-08-23

### Fixed
- **`agentclaw bots` columns now align.** The username column was a fixed width,
  so a handle longer than it pushed the status columns out of line. It's sized to
  the widest bot across all hosts now, with the live `--check` verdict in its own
  aligned column.

## [0.21.0] — 2026-08-23

### Added
- **`agentclaw bots` — a Telegram-bot census** to find slots you can reclaim.
  Telegram has no API to list the bots an account owns, so the tool enumerates
  every bot this install (and, consolidated, each registered peer server) uses,
  classified **in-use** (a RUNNING agent) / **reclaimable** (a stopped/failed
  agent, or an unleased pool bot) / **dead** (`--check` asks Telegram and the
  token is invalid). `--check` adds a live `getMe`/poll probe — and never
  poll-probes a RUNNING agent's bot, so a live poller is undisturbed. Prints a
  reminder that OpenClaw's own bots and `@BotFather → /mybots` are outside its
  view. New `GET /v1/bots` (machine-owner-gated, with `?live` / `?consolidated`).

### Fixed
- **Backups panel showed every agent as "deleted" with no Restore**, on a host
  with agents across more than one owner (e.g. a family fleet). The panel is
  machine-owner-gated and backups are machine-level — every volume, all owners —
  but the volume→agent match was scoped to the *caller's* agents, so anyone
  else's showed unmatched. Match against all active agents now; restore likewise
  lets the host owner restore any agent on the box, not only ones they own.
- **"Back up now" moved to the top** of the Backups panel, above the list.

## [0.20.0] — 2026-08-23

### Added
- **Adopt an existing OpenClaw agent from the web app.** The `adopt` flow that
  brought Tech Advisor and Stock Advisor in was CLI-only; now it's the front
  door for anyone migrating. **New agent → "Already built one in OpenClaw? Bring
  it in →"** points at a workspace folder, shows a preview (files/size, what's
  skipped, the bot it already owns and whether taking it over is safe right
  now), then creates the managed agent and copies the whole workspace.
  - Mirrors the CLI exactly: reuse the workspace's bot (a checkbox, on by
    default, carrying its approved members so nobody re-pairs), paste a BotFather
    token, or lean on a pool bot; a still-live bot is blocked with the hand-over
    steps; and a failure part-way deletes the half-made agent so a retry doesn't
    collide on the name. Built entirely on the existing `/v1/workspaces/inspect`
    and `/v1/agents/:id/adopt-workspace` endpoints — no new backend.

## [0.19.0] — 2026-08-23

### Added
- **Restore an agent from a backup**, per-agent, from the Backups panel. Where a
  snapshot only reverts the three definition files (SOUL/AGENTS/MEMORY), this
  replaces an agent's **entire volume** with the copy from a chosen backup set —
  the complete-state recovery the snapshot can't do. The nightly tarball format
  is exactly what the provider's `importState` consumes, so it's a clean
  stop → import → start swap.
  - Hard-gated: `POST /v1/backups/restore` is owner-only and holds the busy
    guard like a snapshot restore; the UI makes you type the agent's name to
    confirm, since it overwrites live memory. A safety copy of the current
    volume is taken first and rolled back if the extract fails, so a broken
    archive can't corrupt a working agent. The agent is stopped for the swap and
    restarted only if it was running before.
  - The panel now matches each backed-up volume to a live agent, showing a
    Restore button per agent (and its real name); a tarball whose agent has been
    deleted is shown greyed with no Restore.

## [0.18.0] — 2026-08-23

### Added
- **A Backups panel** (⚙ Settings → Backups). The nightly `backup-volumes.sh`
  job has always written dated backup sets to disk, but there was no way to see
  them in-app. The panel lists every set newest-first — date, total size, how
  many agents it holds, and a warning when a set is missing the registry or the
  decryption key — and lets the machine's owner **Back up now** or delete an old
  set. "Back up now" runs the script in the background and the panel polls for
  the result, so a multi-minute run never hangs the request.
  - New `GET /v1/backups`, `POST /v1/backups/run`, `DELETE /v1/backups/:date`,
    all gated to the local-host owner. They return only metadata — dates, sizes,
    what's present — and **never serve the backup files**, which hold bot tokens
    and the decryption key in the clear. Prune refuses any name that isn't a
    `YYYY-MM-DD` directory directly under the backups dir (no path traversal).

## [0.17.2] — 2026-08-23

### Fixed
- **The `agentclaw` CLI printed nothing and exited 0 for every command.** The
  "run only when invoked directly" guard compared `process.argv[1]` against this
  module's path, but the installed `agentclaw` bin is a symlink — the paths never
  matched, so `main()` never ran. The guard now resolves both sides through
  `realpath`. (Regression since ~v0.10.0, when the guard was added to make
  `cli.ts` importable by tests.)

### Changed
- **One Import button instead of two.** The header had separate **Restore** (full
  backup) and **Import** (shared template) buttons doing near-identical uploads.
  Now a single **Import** takes any `.agentclaw` file: the server sniffs the
  archive's `format` tag and routes it — a full copy is restored as the *same*
  agent, a template stands up a *fresh* one. `POST /v1/agents/import` auto-detects
  and returns a `kind` so the app toasts the right thing; `/v1/agents/restore`
  stays for the CLI's explicit `restore` verb. The format sniff (`peekFormat`) is
  bounded like the real import, so an unreadable or oversized file safely falls
  through to the validating restore path.

## [0.17.1] — 2026-08-23

### Changed
- **Clearer labels for the two file tools**, by audience: **Back up → Download**
  ("a copy of this agent, for me") and **Export → Share** ("a copy of its
  training, for someone else"). CLI gains `download` / `share` (with `backup` /
  `export` kept as aliases); endpoints unchanged. Final set of verbs:
  **Clone · Rehost · Download/Restore · Share/Import**.
- **The copy/move actions are grouped on the card's front row**, in order —
  **Clone · Download · Share · Rehost** — instead of being split between the row
  and the ⋯ menu. The ⋯ menu now holds only observability (Usage, Health, Logs,
  OpenClaw, Telegram Web).

## [0.17.0] — 2026-08-22

### Added
- **Clone an agent.** Duplicate an agent on the same machine — a **faithful**
  copy (memory included; you own both, so there's no privacy concern) with its
  own bot and a new name, owned by you. Card ⋯ menu, or `agentclaw clone`.
  `POST /v1/agents/:id/clone`.

### Changed
- **Clearer transfer names** — the save/export/load/import pairs were near-
  synonyms. Now four intents map to four distinct verbs: **Clone · Rehost · Back
  up · Export.**
  - **Save / Load → Back up / Restore** — a complete private copy of an agent to
    a file and back. `/v1/agents/:id/backup`, `/v1/agents/restore`; CLI `backup`
    / `restore`.
  - The file-history snapshot **"Restore" → "Revert"** — freeing "Restore" for
    the above, and a better word for undoing an edit. CLI `revert`.
  - Unchanged: **Rehost** (server→server), **Export / Import** (share a template).
- **Templates now include memory by default** — a faithful copy of the parent —
  with an opt-out ("persona & instructions only") for when the memory is personal
  and headed to someone else (`?excludeMemory` on the export).
- **Install app** moved to the header's account row (it's not an agent action).

## [0.16.0] — 2026-08-22

### Added
- **Share a trained agent — Export / Import (templates).** A template is a
  shareable copy of an agent with **no identity**: it carries the trained
  `SOUL.md` + `AGENTS.md`, the AI *vendor* preference, and a checklist of the
  data sources and env-var *names* it expects — but **no bot token, members,
  conversation history, or memory**. Safe to email.
  - **Export** (agent card ⋯ menu, or `agentclaw export`) downloads the template.
  - **Import** (header, or `agentclaw import`) stands up a **fresh** agent: the
    importer owns it, gives it its own bot (pool or paste — the normal create
    flow), binds their own AI source, and invites their own people. The trained
    files seed the new agent at first provision; import reports what still needs
    wiring up. `GET /v1/agents/:id/export`, `POST /v1/agents/import`.
  - Distinct from **Save/Load** (same agent, whole identity) and **Rehost**
    (server→server move). Memory is excluded by default; opt-in curated memory
    is a planned follow-up.

## [0.15.0] — 2026-08-22

### Changed
- **Renamed the transfer tools for clarity**, ahead of a new share-a-copy feature:
  - **Export / Import → Save / Load** — a complete private copy of an agent (bot
    token, members, memory) to a file and back. `POST /v1/agents/:id/save`,
    `POST /v1/agents/load`; CLI `agentclaw save` / `load`.
  - **Move / Migrate → Rehost** — the one-step server-to-server transfer
    (dgx → GCE). `POST /v1/agents/:id/rehost`; CLI `agentclaw rehost` (`migrate`
    kept as an alias). No behaviour change — same mechanics, clearer names.
  - This frees **Export / Import** for the upcoming *shareable template* feature.

## [0.14.0] — 2026-08-21

### Added
- **Reorder group sections.** Each group header now has ▲▼ controls to move the
  whole section up or down; the order is saved per account (ungrouped stays
  first, unordered groups fall back to alphabetical). `POST /v1/groups/move`.

### Changed
- The **🏷 Group** button is back on the card's front row (out of the ⋯ menu).

## [0.13.1] — 2026-08-21

### Changed
- **Header reorganized into two rows.** Top row: app name, your account name, a
  light/dark **slider**, and Sign out. Second row: Rebuild all, Install app,
  Import, ⚙ Settings. The theme toggle is now a slider (☀/🌙) instead of a button.

## [0.13.0] — 2026-08-21

### Changed
- **"Get the app" is clearer and works across browsers.** The install button is
  now always offered (until installed), and opens a dialog with **per-browser
  steps** (iOS Safari, iOS Chrome/Firefox, Android, desktop) plus a **QR code**
  of the app's address so you can point another phone's camera at it to open
  AgentClaw. One-tap install still fires where the browser supports it
  (Chrome/Edge/Android/desktop).

### Added
- `GET /app-qr.svg` — a scannable QR of the app's public URL (public, like the
  other PWA shell assets), backing the "Get the app" dialog.

## [0.12.1] — 2026-08-21

### Changed
- **Clearer "Install app" help.** Instead of a terse one-line alert, tapping
  Install (when the browser has no one-tap prompt, e.g. iOS Safari) now shows a
  short numbered guide — where the Share button is, "Add to Home Screen", and the
  common "you're in an in-app browser" gotcha.

## [0.12.0] — 2026-08-21

### Added
- **OpenClaw runtime-version control.** The app now knows what OpenClaw version
  the shared runtime image is on and whether a newer **stable** exists upstream
  (it reads OpenClaw's npm dist-tags):
  - **⚙ Settings → Runtime** shows the image version, the latest stable on npm
    (and the `extended-stable` track), and how many agents lag the current image.
  - `agentclaw runtime` prints the same from the CLI.
  - `agentclaw upgrade-image [--version <X>] [--candidate]` rebuilds the shared
    image to a new OpenClaw version (default: latest stable) — `--candidate`
    builds without promoting `:latest`, so you can smoke-test first.
  - `GET /v1/runtime` backs both (npm lookup cached, best-effort).

  Deliberately **no web button**: an image rebuild is a slow, host-side,
  fleet-wide operation, so it lives in the CLI. See `docs/agent-environment.md`.

## [0.11.2] — 2026-08-21

### Changed
- Clicking the backdrop (outside the panel) now dismisses any open dialog —
  Configuration, Definition, Tasks, etc. — the same as pressing Escape.

## [0.11.1] — 2026-08-21

### Changed
- Promote **⏰ Tasks**, **Export**, and **Move…** back onto the card's front row;
  the ⋯ menu now holds Usage, Health, Logs, OpenClaw, Group, and Telegram Web.

## [0.11.0] — 2026-08-21

### Changed
- **Agent card redesign.** The card is leaner: primary actions stay out front
  (Telegram App · Invite… · 📖 Definition · ⚙ Configuration · Stop/Start ·
  Rebuild · Delete) and everything observational or occasional moves into a **⋯
  overflow menu** (Tasks, Usage, Health, Logs, OpenClaw, Export, Move…, Group,
  Telegram Web).
- **Edit is split into two tabs**, opened by their own card buttons: **📖
  Definition** (name, persona & memory files, history, shared-memory) vs **⚙
  Configuration** (AI source & model, data, env vars, bot token).

### Fixed
- The **OpenClaw (debug)** link opened a path current OpenClaw 404s
  (`/chat/<slug>`); it now opens the gateway root, where the Control UI lives.
- Telegram Web no longer carries a stray accent style; the single accented action
  is now **Telegram App**, the way you actually open an agent.

## [0.10.0] — 2026-08-21

### Added
- **Health & usage on every surface.** `agentclaw health <agent>` and
  `agentclaw usage <agent>` (CLI), plus `get_health` / `get_usage` read-tier
  management-bot tools with `/health <ref>` and `/usage <ref>` slash commands —
  so "is it actually answering?" and "what's it using?" can be asked from the CLI
  and Telegram, not only the web app. Closes the observability parity gap the
  audit flagged.

### Changed
- The CLI `folders` command is extracted into a testable unit, and `cli.ts` now
  guards its entrypoint (importing it no longer runs the CLI). No behaviour
  change — its rm legacy-vs-data-source branch is now covered by tests.

### Internal
- +13 tests: the `folders` command (list, add, add-repo, rm legacy vs data
  source, `--none`, bad subcommand), the CLI health/usage formatters, and the
  broker `get_health` / `get_usage` read tools.

## [0.9.1] — 2026-08-21

High-effort audit follow-up (v0.4.1–v0.9.0 surface).

### Security
- **Per-agent env vars are validated by shape, not a name deny-list.** The old
  list blocked credential *names* but not endpoint/proxy redirects
  (`ANTHROPIC_BASE_URL`, `HTTPS_PROXY`, …). On a **shared** AI profile that left a
  path for a second account to point the shared credential at their own server
  and exfiltrate it. Model-provider/credential families, proxy vars, and
  loader/TLS knobs are now all refused; the shared-profile credential hand-off is
  documented in `docs/ai-profiles.md`.
- Git data-source hostnames must start alphanumeric — a leading-dash host could
  reach in-container `ssh` as an option rather than a hostname.

### Fixed
- **Deleting a migrated-away agent no longer recycles its bot.** The bot belongs
  to the peer that received the agent; releasing it back into this pool let a new
  local agent lease it and fight the peer for the same Telegram token.
- **An interrupted delete is recoverable.** If the runtime teardown fails, the
  agent parks in FAILED (retryable) instead of wedging in DELETING forever with
  its secrets un-scrubbed; a retried Delete re-enters and completes.
- **A combined agent PATCH is atomic.** A request that changed the name/profile
  *and* the memory policy no longer commits the name/profile when the
  memory-policy write 502s — the whole request rolls off.
- Usage and Health "start the agent" errors no longer say "scheduled tasks."
- Health no longer returns a contradictory `{status: healthy, ok: false}` when
  the gateway omits its `ok` field.

### Added
- **`/events` management-bot slash command** — the deterministic layer can now
  read the fleet timeline, matching the `list_events` tool (was LLM-only).

### Changed
- The cron "Run now" button guards against a double-fire and confirms a shell task.

### Internal
- +15 tests (358 total) covering the delete teardown (secret scrub, migrated-bot
  skip, interrupted-delete retry), the env shape-blocklist, the sharedMemory
  502/ordering + combined-PATCH atomicity, health degraded combinations, and the
  cron run/enable failure paths — several were silent-regression gaps.

## [0.9.0] — 2026-08-21

### Added
- **Agent health check.** A **❤️ Health** view (per running agent) probes the
  agent's own OpenClaw gateway live and verdicts it *responding / degraded / not
  answering*: event-loop health, whether the Telegram channel is actually
  connected (with the last error and reconnect count), and any plugin errors.
  This is distinct from the tracked state — an agent can read "running" yet have
  quietly stopped responding. `GET /v1/agents/:id/health`.

## [0.8.0] — 2026-08-21

### Added
- **Per-agent usage.** A **📊 Usage** view on each running agent shows cumulative
  tokens **by model**, session count, and last-active — read from the agent's own
  OpenClaw session store (`GET /v1/agents/:id/usage`). Billing context is honest
  rather than a fabricated dollar figure: *included (&lt;subscription&gt;)* for a Max
  profile, *local — no API cost* for Ollama, and the model's list price for an
  API-key agent so you can judge. (Precise per-agent cost isn't derivable — the
  counter is combined input+output with no cumulative split, and subscription
  agents have no marginal cost.)

## [0.7.0] — 2026-08-21

### Added
- **Audit-log viewer.** The recent-activity card gains a **See all →** link that
  opens the full audit log: browse up to 200 events, **filter to one agent**, and
  see each event's recorded **detail** (which model, which member, the error
  reason) and exact time — not just the one-line summary the card shows.
  `GET /v1/events` gains an optional `?agentId=` filter, scoped to agents the
  caller can already see (no cross-owner probing).
- **`list_events` management-bot tool.** The Telegram bot can now read the fleet
  timeline (read tier, optional per-agent filter) — the tool the docs described
  but hadn't shipped.

## [0.6.0] — 2026-08-20

### Added
- **Per-agent secrets / environment variables.** Give an agent its own
  credentials — an API key a script needs — in **⚙ Edit → Environment
  variables**. Values are secrets: stored encrypted in the SecretStore, never
  returned by the API, write-only from the app (only names are shown), and
  injected into the runtime on the next rebuild. A reserved set
  (`ANTHROPIC_API_KEY`, `PATH`, `PYTHONPATH`, …) is refused so a variable can't
  shadow the agent's managed AI auth or its runtime paths — and the managed env
  is merged last, so it wins regardless. See `docs/agent-environment.md`.
  - *Not yet carried by export/migrate* — re-add variables after moving an agent.

### Fixed
- Deleting an agent now scrubs its **data-source deploy keys and env-var
  secrets** from the SecretStore, not just its bot token — a tombstone no longer
  leaves live credentials behind.

## [0.5.0] — 2026-08-20

### Added
- **Scheduled tasks in the app.** A new **⏰ Tasks** view on each running agent
  lists its OpenClaw cron jobs and lets you enable, disable, **run one now to
  test**, or delete — no shelling into the container. It's driven through the
  in-container `openclaw cron` CLI (never the store directly), and tasks live on
  the agent's durable volume, so they survive rebuilds like MEMORY.md. Adding a
  new task is still done by asking the agent in chat; declarative add/edit is the
  next step.

### Changed
- **`agentclaw folders` now manages every kind of data source, not just legacy
  read-only paths.** It lists folders *and* git repos in one view (matching the
  web UI) and gains subcommands — `add <path> [--rw]`, `add-repo <git-url> [--rw]`
  (which prints the deploy key), and `rm <name>` (works on both legacy folders
  and newer data sources). Previously the CLI read only the old shared-paths
  list, so an agent given a writable folder or a git repo in the web UI
  misreported *"reads no host folders."*

## [0.4.1] — 2026-08-20

### Added
- **Organize the fleet.** Sort agents into named groups and reorder them within
  a group (a dedicated 🏷 Group button plus ▲▼ controls), so a large fleet stays
  legible.
- **Shared memory is now an explained checkbox** in ⚙ Edit, replacing the bare
  "Make private / Make shared" card button. It spells out what shared vs private
  means, applies on new conversations, and — when the agent has other members —
  shows *why* it is locked instead of silently disappearing.

### Fixed
- **The memory-policy toggle can no longer desync.** AGENTS.md is rewritten
  first, and the stored flag is persisted only if that write succeeds; a failed
  write now reports an error and changes nothing, instead of leaving the database
  and the agent's own file permanently disagreeing (nothing reconciled them
  afterwards — rebuild never overwrites an existing AGENTS.md).
- **No silent double-mount.** A legacy shared folder that would land at the same
  `/data/<name>` as an existing data source is now refused, rather than letting
  Docker quietly keep only one of the two.
- **Reserved git names blocked.** A git data source whose repo name would collide
  with the agent's own runtime directories (`agents`, `config`, `sessions`, …) is
  rejected up front.
- **Agent ordering no longer ties.** New agents get a strictly-increasing order
  instead of a wall-clock stamp — two created in the same millisecond used to
  tie, which made "move up / down" a silent no-op. Moving an agent into another
  group now drops it at the end of that group rather than an arbitrary spot.

### Changed
- Buttons show a pressed state, so a tap is unmistakable.
- Clarified that a git data source's deploy key is identical whether read-only or
  read-write; write access is granted by ticking "Allow write access" when the
  key is registered on the host.
- **Docs:** corrected the management-bot tool names and removed a documented-but-
  nonexistent `events` tool; marked git data sources as shipped; documented the
  `AGENTCLAW_TLS_CERT` / `AGENTCLAW_TLS_KEY` and `AGENTCLAW_MAX_AGENTS_PER_ACCOUNT`
  settings and the `src/mgmt/` management bot in the README; trimmed the
  duplicated broker documentation.

### Internal
- Removed dead code: `suggestBotUsername`, `isTerminal`, and the never-read `key`
  field across the channel interface and its three implementations.

## [0.4.0] — 2026-08-20

### Added
- **Data sources — one place to see what an agent can access.** A unified,
  per-agent list (Edit → Data) with a card summary (`reads 2 folders · 1 git
  repo`). Folders can now be **writable** (gated to the machine owner, warned),
  and **git repos** are first-class: adding one generates a repo-scoped deploy
  key (private half in the SecretStore, public half shown with a direct GitHub
  link), and the repo is cloned onto the agent's volume so it can read — or
  commit and push. See `docs/data-sources.md`.
- **Telegram management bot.** Control the fleet from Telegram: list/start/stop/
  rebuild agents and approve pairing requests, each change confirmed with a tap.
  Built on a deterministic broker (typed tool tiers, single-use confirm tokens,
  allowlist) with an optional LLM layer for natural-language control that gains
  no authority the broker doesn't already gate. Set up with `agentclaw mgmt-bot
  setup`; discoverable in ⚙ Settings → Access. See `docs/control-interfaces.md`
  and `docs/management-broker.md`.
- **Installable app (PWA).** The web UI installs to a phone home screen and runs
  standalone; an in-app "Install app" button appears in a secure context.
- **Light / dark theme** with a header toggle (defaults to light), and a wider
  content column so agent cards use the screen.

### Changed
- The "update available" card no longer over-claims an OpenClaw version bump when
  only the runtime image changed — it words itself from the two versions.

### Fixed
- `npm audit fix` for the `fast-uri` host-confusion advisory (transitive via
  fastify); `npm audit` now clean.

### Docs
- GCE single-VM deploy recipe (`docs/deploy-gce.md`); management bot + mobile app
  spec and broker design.

## [0.3.1] — 2026-08-18

### Added
- **Native TLS.** Set `AGENTCLAW_TLS_CERT` and `AGENTCLAW_TLS_KEY` (PEM file
  paths) to serve HTTPS directly — no reverse proxy required for a small
  single-host deployment. It's both-or-neither (a half-configured pair fails
  loudly rather than silently serving plaintext). A reverse proxy that
  terminates TLS in front stays a valid alternative; the app just no longer
  requires one.

### Changed
- Startup now warns when bound to a non-loopback address **without** TLS — the
  password and all traffic would otherwise cross the network in the clear.

## [0.3.0] — 2026-08-18

### Added
- **Python, git, and ssh in the runtime image.** Agents whose workspaces carry
  scripts can now run them (`python3 script.py`, as cron jobs do) and use git
  over SSH. The base image stays lean — it ships the interpreters and git, but
  **no** third-party Python packages.
- **Per-agent Python libraries on the volume.** An agent installs what it needs
  onto its own durable volume — `pip install --target /home/node/.openclaw/pylibs <pkg>`
  — and the entrypoint prepends that dir to `PYTHONPATH`. Heavy, app-specific
  stacks (e.g. pandas/numpy/yfinance for a market agent) stay out of the image
  every other agent shares, and survive rebuilds because the volume is durable.
  See `docs/agent-environment.md`.

### Notes
- Adopting a hand-built agent brings its **workspace**, but not the runtime
  environment it accreted on the host (Python libs, data directories, crons).
  `docs/agent-environment.md` documents how to reconstruct that: volume libs,
  read-only data mounts (agent folders), and git-clone-on-volume for versioned
  data the agent maintains (with a repo-scoped deploy key). Making this
  declarative and carried by `adopt` is planned follow-up.

## [0.2.1] — 2026-08-18

### Fixed
- **Adopt no longer lists the owner as a member of their own agent.** Adopting a
  hand-built OpenClaw agent seeds members from the source bot's `allowFrom`,
  which includes the owner's own Telegram id — and the owner seat already
  carries it via pair-once, so the owner ended up listed twice (owner + member).
  Seeding now skips any Telegram id already admitted (the owner seat included),
  and dedupes repeats within the seed list. Existing split rows can be repaired
  with `scripts/link-owner-telegram.ts`.

## [0.2.0] — 2026-08-18

### Added
- **Per-agent model selection.** One AI source can now drive different agents on
  different models. Each cloud agent may pin any model from its source's
  switchable list, or follow the source default — set in **Edit → Model** (the
  row appears only for cloud sources), applied on the next Rebuild. Use a cheap
  model for simple agents and a top model for the demanding ones without
  standing up a second source. Local sources still run their single resident
  model, so the picker is hidden for them. See `docs/ai-profiles.md`.

### Changed
- **AI-source dropdowns name the source by kind, not model.** The Edit and
  Create source pickers now read e.g. `My Claude — Claude` / `Local Qwen —
  Local` instead of repeating a model id, which collided with the new per-agent
  Model picker beside it.
- `agentclaw ai <agent>` (CLI) now reports the agent's *effective* model — its
  per-agent override when set — instead of the source's default.
- README documents per-agent model selection.

### Fixed
- A per-agent model pin can no longer reach the runtime after it goes stale.
  Editing a source's model list sweeps and clears any agent pin it no longer
  offers, and `effectiveModel` falls back to the source default for any pin not
  on the current menu — closing the "green build that dies on first use" gap.
- `PATCH /v1/agents/:id` validates a combined source-switch + model request
  before any write, so a request rejected for a bad model no longer leaves the
  agent half-switched to the new source.

## [0.1.0]

Initial baseline: create and manage OpenClaw agents on local or cloud hosts,
Telegram pairing and membership, AI sources (Anthropic / Google / local Ollama,
API key or on-machine subscription), source sharing across accounts, per-agent
read-only folder mounts, agent export/import and re-hosting, snapshots, and the
web app + CLI.
