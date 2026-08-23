# Changelog

All notable changes to AgentClaw are recorded here. Dates are ISO (YYYY-MM-DD).

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
