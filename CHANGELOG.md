# Changelog

All notable changes to AgentClaw are recorded here. Dates are ISO (YYYY-MM-DD).

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
