# Control interfaces: Telegram management bot & mobile app

Two new clients for the existing control plane. Neither needs a backend rewrite —
the web UI and CLI already prove the `/v1` API is a complete control surface.
This spec pins down each client concretely, the small set of shared server-side
additions they want, and a build order.

Scope note: this is the **management** plane (create/configure/operate agents).
*Talking to* an agent stays on Telegram (its own bot) unless the app opts into
in-app chat (§B.7).

---

## 0. Shared foundation

### Auth — one mechanism for both clients
Both authenticate with a **personal access token** (the existing "CLI token"):

| Action | Endpoint |
|---|---|
| Mint a token (labeled) | `POST /v1/cli-tokens` → `{ id, token }` |
| List tokens | `GET /v1/cli-tokens` |
| Revoke | `DELETE /v1/cli-tokens/:id` |

Every request then carries `Authorization: Bearer <token>`; it resolves to an
owner in **both** password and identity modes (`cliTokenOwner` in
`src/api/auth.ts`). The token is the whole credential, so treat it like a
password: store it in the OS keystore (app) or an encrypted config (bot), label
it per device (`"pixel-app"`, `"tg-bot"`), and revoke per device.

### The `/v1` contract both clients drive
Grouped for reference (full list in `src/api/routes.ts`):

- **Fleet:** `GET /v1/agents`, `GET /v1/agents/:id`, `POST /v1/agents`,
  `PATCH /v1/agents/:id` (name, model, aiProfileId, sharedPaths, sharedMemory),
  `DELETE /v1/agents/:id`
- **Lifecycle:** `POST /v1/agents/:id/{start,stop,rebuild,provision}`
- **Observe:** `GET /v1/agents/:id/logs`, `GET /v1/events`, `GET /v1/pool`
- **Members & pairing:** `GET /v1/agents/:id/members`,
  `DELETE /v1/agents/:id/members/:userId`, `GET /v1/agents/:id/pairing`,
  `POST /v1/agents/:id/pairing/approve`, `POST /v1/agents/:id/pairing/deny`
  (OpenClaw has no deny verb, so this is an atomic edit of the on-volume
  pairing store — a "not now", not a ban: they can ask again)
- **AI sources:** `GET/POST /v1/ai-profiles`, `PATCH /v1/ai-profiles/:id`,
  `GET /v1/ai-profiles/:id/available-models`, `DELETE /v1/ai-profiles/:id`,
  `GET /v1/ai-profiles/:id/credential` (owner only — reveals the stored token
  so a second installation can be given the same source; every read is logged)
- **Source usage:** `GET /v1/ai-profiles/usage` (per-source requests, tokens,
  rate-limit state for the caller's own agents), `POST /v1/ai-profiles/usage/sample`
  (machine owner: measure now)
- **Accounts (accounts mode):** `POST /v1/local-accounts/bootstrap` (first run
  only, loopback or the boot-printed setup code), `POST /v1/login`,
  `GET/POST /v1/local-accounts`, `GET/POST /v1/local-accounts/claim` (an
  invitation being accepted), `POST /v1/local-accounts/:id/password`,
  `DELETE /v1/local-accounts/:id`
- **Peers (A2A):** `GET/PUT /v1/agents/:id/peers` (the PUT carries `peerIds`
  and, optionally, `allowActions` — the peers permitted to ask this agent to
  act), `POST /v1/agent-peers/mesh`, `POST /v1/agents/:id/message` (the consult
  itself, authenticated by the calling agent's own token)
- **Chat bridge:** `GET /v1/agents/:id/gateway` → `{ port, token }`
- **Invites:** `POST /v1/agents/:id/invites`, `GET /v1/invites/:code`, `POST /v1/join`
- **Fleet-wide pending joins:** `GET /v1/pending` — every pending pairing across
  the caller's RUNNING agents, flattened and attributed, so the management bot
  can poll once and push an approval prompt (no web UI / tailnet needed)

### Small server-side additions both clients want
Prioritized; each is self-contained and reuses what exists.

1. **SSE stream** — `GET /v1/events/stream` (`text/event-stream`) wrapping the
   existing event log, so clients get live state instead of polling. ~a day.
2. **OpenAPI spec** for `/v1` — generate a typed client for the app and validate
   the bot, instead of hand-writing request shapes. ~a day.
3. **Push relay** (app + bot alerts) — a device-token registry
   (`POST /v1/push/register`) plus an internal "event → push" sender (FCM/APNs).
   Needed only for background notifications; SSE covers foreground.
4. **Account-linking** (identity mode only) — a one-time code that binds an
   external identity (a Telegram id, a device) to a Hatchabot account.

Password mode needs none of #4; a single-owner deployment can ship the bot and
app today with just tokens.

---

## A. Telegram management bot

### Architecture — a spectrum, and where we land
Three designs, by how much authority the model holds directly:

1. **Pure command bot** — deterministic slash-commands → `/v1`. Max safety, min
   flexibility; can only answer what you pre-built.
2. **LLM + confirmed tool broker** *(recommended)* — the model parses, reasons,
   and summarizes; it **proposes** actions as typed tool-intents; a deterministic
   **broker** decides and executes. Reads auto-run; mutations are human-confirmed.
   Natural language and cross-fleet reasoning, without handing raw authority to a
   token-predictor exposed to untrusted text.
3. **Autonomous LLM holding the raw token** — powerful and **disqualified**: an
   agent that can be talked into `DELETE /v1/agents/:id` must not exist.

We build **#2**. The load-bearing idea is **separate reasoning from authority**:
the model never holds the `cli-token` and never calls `/v1` directly. It emits
structured tool calls into a broker (a small service beside the bot) that holds
the token, enforces policy, and is the *only* thing that touches `/v1`.

```
Telegram ──▶ bot ──▶ [LLM: parse/reason] ──▶ tool-intent
                                                  │
                          allowlist + policy ◀────┤
                                                  ▼
                    read → execute now      mutate → confirm button ──▶ broker ──▶ /v1
```

The bot runs as its own process (a systemd unit beside the control plane, or an
OpenClaw-hosted job) and needs its own BotFather bot (bots are a hand-minted
pool, ~20/account ceiling — budget one slot), separate from the bots you chat
with agents on. Name it unmistakably (`@MyClawAdminBot`).

### Identity binding
- **Password mode:** an env allowlist of your Telegram id(s); the bot acts as
  the single owner with its token. Trivial.
- **Identity mode:** a linking flow — the web app issues a short code tied to
  your account; you send `/link <code>` to the bot; the bot binds your Telegram
  id → your owner and stores a per-user token. Unlinked ids get nothing.

Every inbound update is checked against the allowlist **before** the model runs,
and again in the broker before any `/v1` call. The allowlist is a code check, not
a prompt instruction — the system prompt is never a security boundary.

### The broker & tool tiers
The model is given a fixed set of **typed, least-privilege tools** — never a
"call any endpoint" escape hatch. Each tool has a tier that fixes its handling,
in the broker, regardless of what the model (or injected text) "wants":

| Tier | Handling | Tools → endpoint |
|---|---|---|
| **read** | execute immediately, no confirm | `list_agents` → `GET /v1/agents`; `get_agent` → `GET /v1/agents/:id`; `get_logs` → `GET …/logs`; `list_members` → `GET …/members`; `list_pending` → `GET …/pairing`; `get_pool` → `GET /v1/pool`; `list_events` → `GET /v1/events`; `get_health` → `GET …/health`; `get_usage` → `GET …/usage`; `get_runtime` → `GET /v1/runtime`; `list_images` → `GET /v1/images`; `get_image_log` → `GET /v1/images/:name/log` |
| **mutate** | require a human-confirm tap showing the **resolved** action | `start_agent`/`stop_agent`/`rebuild_agent` → `POST …/{start,stop,rebuild}`; `approve_member` → `POST …/pairing/approve`; `remove_member` → `DELETE …/members/:userId`; `set_model` → `PATCH /v1/agents/:id`; `create_agent` → `POST /v1/agents` + file writes + `PATCH` (full-spec proposal card, 10-min TTL); `update_definition` → `PUT …/files/:name` + `PATCH` (diff-stat card; server snapshots first); `build_image` → `POST /v1/images` (Dockerfile snippet on the card, 10-min TTL); `rebuild_image` → `POST /v1/images/:name/rebuild`; `remove_image` → `DELETE /v1/images/:name` (refused while pinned); `build_base_candidate` → `POST /v1/runtime/build` (candidate only); `try_base_candidate` → `PATCH image` + rebuild of one agent; `end_base_trial` → unpin + rebuild. **No promote tool**: fleet-wide promotion is web-app only |
| **forbidden** | not exposed to the model at all — deep-link to web | `add_ai_key`, paste bot token, set password, edit `MEMORY.md`, `delete_agent` (or gate behind a typed-name double-confirm) |

Inputs are schema-validated (agent id must resolve to one the owner owns; enums
for model, etc.). The broker's token is owner-scoped, and it starts in
**read-only mode** — a `/mode readwrite` toggle (allowlisted) arms mutations.

Full tool JSON schemas, the resolution rules, the result envelope, and the
confirm-token design are in **`docs/management-broker.md`**.

### Confirmation-gate flow (the core safety mechanism)
A hijacked model can only *propose*; the broker resolves the intent to a concrete
target, renders a `[Confirm] [Cancel]` card whose `callback_data` is an opaque,
single-use, short-TTL token, and only calls `/v1` on your tap. See
`docs/management-broker.md` for the confirm-token flow in full.

Irreversible/batch actions get extra friction (typed-name confirm; no "confirm
all"). Keep destructive confirmations rare and specific to avoid tap-fatigue.

### Untrusted-content rules (closing the injection surface)
The model reads fleet content that *other, less-trusted things produced* — agent
memory, logs, and **member display names taken from Telegram profiles** — and all
of it is treated as hostile input. The load-bearing rule specific to this client:
**no outbound tools** — the management agent's only output is messages back to
*you*, which removes the exfiltration leg entirely. Beyond that, content is fed
metadata-first and can inform proposals but never widen the tool set or skip a
confirm. See `docs/management-broker.md` for the full untrusted-content handling.

### Slash commands (the deterministic layer, always available)
The typed commands coexist with the model — power-user shortcuts and a no-LLM
fallback. They hit the same broker tools, so the same tiers/confirms apply.

| Command | Does | Endpoint(s) |
|---|---|---|
| `/start`, `/help` | Onboard, list commands | — |
| `/list [state]` | Fleet with state · model | `GET /v1/agents` |
| `/agent <ref>` | Detail for one agent | `GET /v1/agents/:id` |
| `/start_agent <ref>` | Start (confirm card) | `POST /v1/agents/:id/start` |
| `/stop <ref>` | Stop (confirm card) | `POST /v1/agents/:id/stop` |
| `/rebuild <ref>` | Rebuild, memory kept (confirm card) | `POST /v1/agents/:id/rebuild` |
| `/model <ref> <model>` | Switch model (validated, confirm card) | `PATCH /v1/agents/:id` |
| `/approve <ref> <code>` | Admit a pairing request (confirm card) | `POST …/pairing/approve` |
| `/logs <ref> [n]` | Tail recent logs | `GET /v1/agents/:id/logs` |
| `/members <ref>` | List members | `GET /v1/agents/:id/members` |
| `/pending <ref>` | Pairing requests for one agent | `GET /v1/agents/:id/pairing` |
| `/events [ref] [n]` | Recent fleet/agent activity | `GET /v1/events` |
| `/health <ref>` · `/usage <ref>` | Live probe · token usage | `GET …/health`, `GET …/usage` |
| `/pool` | Bots free vs used | `GET /v1/pool` |
| `/mode readwrite\|readonly` · `/pause` · `/resume` | Arm/disarm mutations · kill switch | (broker state) |

There is deliberately no `/delete` (Forbidden list) and no create/author slash
command — authoring is plain-language only, because the spec is a document,
not an argument string.

### Inline-button flow (the good part)
Discrete ops map to inline keyboards. `callback_data` encodes `action:agentId`
(bounded to Telegram's 64-byte limit — use short ids). On tap: re-check
allowlist → call the API → edit the message with the result.

- **Agent card** → `[▶ Start] [⏹ Stop] [🔄 Rebuild] [📜 Logs] [👥 Members]`
- **Pairing request** → `[✅ Approve] [🚫 Deny]` → `POST /v1/agents/:id/pairing/approve`
- **Member row** → `[Remove]` → `DELETE /v1/agents/:id/members/:userId`
- **Destructive** (`Rebuild`, `Delete`) → a second `[Confirm]` step.

### Notifications (push, the killer feature)
The bot subscribes to the SSE stream (or polls `GET /v1/events`) and proactively
messages you, with action buttons where relevant:

- pairing request waiting → Approve/Deny inline;
- agent entered `FAILED` → the reason + a `[Rebuild]` button;
- provisioning parked on a human step (bot token needed) → deep link to web;
- pool exhausted.

### Explicitly out of scope (the limitations, restated as rules)
Never over Telegram — the bot deep-links to the web app instead:
- entering **AI API keys, bot tokens, or the app password** — Telegram messages
  live in its cloud, appear in history, and aren't end-to-end encrypted, so chat
  is not a secret-entry channel;
- editing `MEMORY.md` (a poisoned memory is not reversible the way a
  snapshotted SOUL.md edit is — SOUL/AGENTS editing moved to the confirm-gated
  authoring tools in v0.90.0);
- anything where a clumsy file upload is the wrong tool.

### Security checklist
The bot's security rests on a strict in-code Telegram-id allowlist (never the
system prompt), a model that holds no token and no `/v1` access, broker-fixed
tool tiers with human-confirmed mutations, resolved-target confirm cards on
opaque single-use tokens, no outbound tools, read-only-by-default with an
explicit `/mode readwrite`, untrusted-content handling, per-chat rate limits, an
audit trail, and a `/pause` kill switch. The broker-side invariants and the
policy it enforces are enumerated in `docs/management-broker.md`.

### Running it (Phase 1 — implemented)
The deterministic broker + slash commands ship in `src/mgmt/` (`grammy`
transport). Reads run immediately; mutations require a confirm tap; it starts
**read-only** (send `/mode readwrite` to arm). To run:

1. Create a bot with BotFather → `HATCHABOT_MGMT_BOT_TOKEN`.
2. Mint a bearer on the control plane: `POST /v1/cli-tokens` → `HATCHABOT_MGMT_TOKEN`.
3. Put both, plus `HATCHABOT_MGMT_ALLOWLIST=<your telegram id(s)>`, in a
   `.env.mgmt` (chmod 600); optionally `HATCHABOT_URL`.
4. `npm run mgmt`, or install `deploy/hatchabot-mgmt-bot.service` as a user unit.

Or let the CLI do steps 2–4: `hatchabot mgmt-bot setup`.

It refuses to start with an empty allowlist.

**Phase 2 (implemented) — natural language.** Plain-text messages route to an
LLM that proposes tools through the **same broker** — reads run, changes still
become confirm cards. The bot needs **no AI credential of its own**: the
control plane runs the calls (`POST /v1/mgmt/llm/complete`) with the AI
source flagged **🛠 Management** in ⚙ Settings → AI sources (auto-picked when
none is flagged — api-key → setup-token → machine-login). An api-key source
hits the Messages API directly; a subscription source rides the host's
Claude CLI — the sanctioned Max surface, so no new credential is ever needed
(only Anthropic sources qualify; local and other-vendor sources are excluded).
The CLI child is locked down: no built-in tools, no MCP, no session
persistence, minimal env, scratch cwd — a pure completion engine
(`HATCHABOT_CLAUDE_BIN` overrides the binary path,
`HATCHABOT_CLI_TIMEOUT_MS` the 180s call timeout).
`HATCHABOT_MGMT_ANTHROPIC_KEY` — or an ambient `ANTHROPIC_API_KEY` in the
bot's environment — remains as a dedicated-key override for the Telegram
bot (`HATCHABOT_MGMT_MODEL`, default `claude-sonnet-5`, applies only on
that path). The model holds no token and no
`/v1` access; it gains no authority the broker doesn't already gate. Slash
commands keep working alongside it.

**Phase C (implemented) — the web chat pane.** 💬 Manage in the web app hosts
the SAME broker in-process, per signed-in owner: its `/v1` calls dispatch
through the server's own router carrying the caller's auth (the pane can
never do more than the person typing), the LLM runs server-side on the
🛠 Management source, and every change is a card rendered in the pane showing
the FULL spec, executed only on Confirm. Read-only until the "Allow changes"
toggle arms it; single-use/TTL confirm semantics identical to Telegram.
Sessions (history + arm state) are in-memory per owner and clear on restart.

---

## B. Mobile app

### Architecture
A cross-platform client (**React Native** or **Flutter**) of `/v1`, or a **PWA**
first (§B.8). State comes from the API; live updates from the SSE stream;
background alerts from push. No business logic server-side is duplicated.

### Auth
- **Password mode:** login screen → the app mints a `cli-token` (or the user
  pastes one generated in the web app) → stored in Keychain/Keystore.
- **Identity mode:** Google sign-in (the same provider the web app uses) →
  bearer. Same `Authorization: Bearer` on every call.
- Server URL is configurable (self-hosted); default to the deployment's public
  URL.

### Screens → endpoints

| Screen | Contents | Endpoint(s) |
|---|---|---|
| **Login** | Password or Google; store token | `POST /v1/cli-tokens` / identity |
| **Fleet** | Cards: name, state pill, model, last-active; pull-to-refresh + live | `GET /v1/agents` + SSE |
| **Agent detail** | State, start/stop/rebuild; model picker; folders; members; logs | `GET /v1/agents/:id`, `POST …/{start,stop,rebuild}`, `PATCH /v1/agents/:id`, `GET …/logs` |
| **Create agent** | Full form: AI source, model, persona, shared-memory | `GET /v1/ai-profiles`, `POST /v1/agents` |
| **AI sources** | Add **API key** (secure over TLS), model list, shared toggle | `GET/POST /v1/ai-profiles`, `PATCH …`, `GET …/available-models` |
| **Members / approvals** | Members list + remove; pending pairing Approve/Deny | `GET …/members`, `DELETE …/members/:userId`, `GET …/pairing`, `POST …/pairing/approve` |
| **Invites** | Create/share invite link or QR | `POST /v1/agents/:id/invites`, `GET /v1/agents/:id/qr.svg` |
| **Settings** | Manage device tokens, server URL, sign out | `GET/POST/DELETE /v1/cli-tokens` |

Because the app talks over TLS, the **secret-bearing actions the bot can't do —
API keys, bot tokens — belong here.** That's the app's reason to exist beyond
the bot.

### Real-time & background
- **Foreground:** subscribe to `GET /v1/events/stream` for live state and new
  pairing requests.
- **Background:** register the device (`POST /v1/push/register`); the push relay
  delivers "approval needed" / "agent failed" as notifications with actions.

### B.7 Optional: in-app chat with an agent
To make the app also where you *talk to* agents (not just manage them), fetch
`GET /v1/agents/:id/gateway` → `{ port, token }` and open a chat against that
agent's OpenClaw Control UI (proxied through the control plane so the gateway
port needn't be exposed). More work; keep it a later phase — Telegram remains the
default chat surface until then.

### B.8 PWA shortcut (ship a phone app this week)
The web UI is already a single responsive page over TLS. Add `manifest.json` +
a minimal service worker → installable to the home screen, standalone, same
session/token. Near-zero cost, and the fastest path to "an app on my phone."
The native app (push, offline, in-app chat) is the upgrade, not the prerequisite.

---

## Build order

| Phase | Deliverable | Effort | Unlocks |
|---|---|---|---|
| 0 | **PWA-ify the web UI** | hours | Installable phone app now |
| 1 | **Broker + slash commands** (password mode): tool tiers, confirm gates, allowlist, read + lifecycle + approvals + notifications — **no LLM yet** | days | Fast phone ops + push; the hardened surface everything else builds on |
| 2 | **LLM layer** on top of the same broker: natural-language reads/queries/summaries, mutate-by-proposal into the existing confirm gates — *implemented (`src/mgmt/llm.ts`)* | days | Conversational management, safely |
| 3 | **SSE stream** + **OpenAPI spec** | ~2 days | Live updates; typed app client |
| 4 | **Native app** + **push relay** | weeks | Polished app, background alerts, secret entry, create/config |
| 5 | **Identity-mode linking** for bot & app | days | Real multi-user |
| 6 | **In-app agent chat** via the gateway bridge | ~week | App becomes chat surface too |

Recommended start: Phase 0 (today), then Phase 1. Build the **broker first with
deterministic commands** — it's the security-critical piece (tiers, confirms,
allowlist), so harden and validate it *before* the LLM in Phase 2, which only
ever *proposes* into gates that already exist. That ordering is the whole point:
the model can grow more capable without ever growing more authority.

## C. Direct OpenClaw access (owner-only today)

Each agent runs OpenClaw's own **Control UI** — reachable from the agent card's
⋯ menu as *OpenClaw (debug)*. Hatchabot reverse-proxies it at
`/v1/agents/:id/ui/` (HTTP + WebSocket), authorized by the same session as every
other route, so the gateway port stays bound to the host's loopback rather than
being exposed to the LAN/tailnet.

**Status: a debugging tool for the owner, deliberately not a user surface.**

### Two constraints, if this is ever opened up

**1. It requires a browser secure context — `https://` or `localhost`.**
The Control UI uses WebCrypto for device identity, and browsers expose that only
in a secure context. Tailscale encrypting the wire does *not* count: the browser
judges by the URL scheme alone, so `http://<host>.ts.net:8080` is treated exactly
like plain HTTP anywhere else. The symptom is a page that loads and then reports
*"control ui requires device identity (use HTTPS or localhost secure context)"*.

Ways to satisfy it, cheapest first:
- browse on the host itself at `http://localhost:8080` (works today, no setup);
- an SSH tunnel — `ssh -L 8080:127.0.0.1:8080 <host>` — then `http://localhost:8080`;
- HTTPS via `tailscale serve --bg --https=443 http://127.0.0.1:8080`, which needs
  HTTPS Certificates enabled for the tailnet. Note the certificate is published
  in public **Certificate Transparency** logs, so the machine and tailnet names
  become publicly discoverable (not reachable — Tailscale still gates access).
  This is per-node: each Hatchabot server serves at its own `*.ts.net` name, so
  two servers don't collide unless they're on the same machine, where they need
  different HTTPS ports (a path prefix breaks the app, which uses absolute paths).

**2. The bigger issue is authorization, not transport.** The Control UI is an
admin console containing a **terminal** — whoever opens it has a shell inside the
agent's container, and therefore its memory, its connection credentials (gog,
Jira), and any host directory mounted into it. That is strictly more than the
agent's own owner gets through Telegram, and far more than the `user` membership
role is meant to grant (chat only). Handing it to members would bypass the
membership model rather than extend it.

### If the goal is "users can talk to the agent without Telegram"

(Distinct from the shipped 💬 Manage pane: that is the OWNER talking to the
*management assistant* about the fleet. This section is members talking to an
AGENT — still future.)

Build a **chat panel inside Hatchabot**, not access to OpenClaw's console:
- it reuses the existing login and owner/member roles, so there's no new auth story;
- it needs no secure context — it's our own page doing ordinary `fetch` — so no
  HTTPS, no tunnel, no CT-log entry, no extra onboarding step;
- members get exactly what Telegram gives them: conversation, nothing more.

The plumbing already exists: the control plane drives the gateway server-side
(`message send`, `sessions list`), so this is a message list, an input box, and
two routes — not a new transport story.
