# Changelog

All notable changes to AgentClaw are recorded here. Dates are ISO (YYYY-MM-DD).

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
