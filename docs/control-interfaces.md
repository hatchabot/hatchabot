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
  `POST /v1/agents/:id/pairing/approve`
- **AI sources:** `GET/POST /v1/ai-profiles`, `PATCH /v1/ai-profiles/:id`,
  `GET /v1/ai-profiles/:id/available-models`, `DELETE /v1/ai-profiles/:id`
- **Chat bridge:** `GET /v1/agents/:id/gateway` → `{ port, token }`
- **Invites:** `POST /v1/agents/:id/invites`, `GET /v1/invites/:code`, `POST /v1/join`

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
   external identity (a Telegram id, a device) to an AgentClaw account.

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
| **read** | execute immediately, no confirm | `list_agents` → `GET /v1/agents`; `agent_status` → `GET /v1/agents/:id`; `logs` → `GET …/logs`; `members` → `GET …/members`; `pending` → `GET …/pairing`; `pool` → `GET /v1/pool`; `events` → `GET /v1/events` |
| **mutate** | require a human-confirm tap showing the **resolved** action | `start`/`stop`/`rebuild` → `POST …/{start,stop,rebuild}`; `approve_member` → `POST …/pairing/approve`; `remove_member` → `DELETE …/members/:userId`; `set_model` → `PATCH /v1/agents/:id` |
| **forbidden** | not exposed to the model at all — deep-link to web | `add_ai_key`, paste bot token, set password, edit `SOUL.md`/`MEMORY.md`, `delete_agent` (or gate behind a typed-name double-confirm) |

Inputs are schema-validated (agent id must resolve to one the owner owns; enums
for model, etc.). The broker's token is owner-scoped, and it starts in
**read-only mode** — a `/mode readwrite` toggle (allowlisted) arms mutations.

Full tool JSON schemas, the resolution rules, the result envelope, and the
confirm-token design are in **`docs/management-broker.md`**.

### Confirmation-gate flow (the core safety mechanism)
A hijacked model can only *propose*; you see the concrete action before it fires.

1. Model emits a mutate intent, e.g. `stop{agent:"tech-advisor"}`.
2. Broker **resolves** it to a specific target and renders a card:
   *"⏹ Stop **Tech Advisor** (`id 169c…`)?"* with `[Confirm] [Cancel]`.
   `callback_data` carries an opaque, single-use, short-TTL token — never
   free-form model text — so the button can't be forged or replayed.
3. On `[Confirm]`: re-check allowlist → broker calls `/v1` → edit the message
   with the result. On `[Cancel]` or timeout: nothing happens.

Irreversible/batch actions get extra friction (typed-name confirm; no "confirm
all"). Keep destructive confirmations rare and specific to avoid tap-fatigue.

### Untrusted-content rules (closing the injection surface)
The model reads fleet content that *other, less-trusted things produced* — agent
memory, logs, and **member display names taken from Telegram profiles**. Treat
all of it as hostile input:

- **No outbound tools.** The management agent's only output is messages back to
  *you*. No web-fetch, no send-elsewhere — this removes the exfiltration leg, so
  even a fully hijacked read-only model has nowhere to leak to.
- **Metadata first.** Feed the model states, counts, names-as-fenced-strings; pull
  raw memory/log bodies only on explicit request, clearly delimited, never as
  free instructions.
- **Data is never authority.** Content the model reads can inform its *proposals*
  but can't widen its tool set or skip a confirm — those live in the broker.

### Slash commands (the deterministic layer, always available)
The typed commands coexist with the model — power-user shortcuts and a no-LLM
fallback. They hit the same broker tools, so the same tiers/confirms apply.

| Command | Does | Endpoint(s) |
|---|---|---|
| `/start`, `/help` | Onboard, list commands | — |
| `/list` | Fleet with state · model · last-active (paginated) | `GET /v1/agents` |
| `/agent <name>` | Detail card + action buttons (below) | `GET /v1/agents/:id` |
| `/start <name>` | Start | `POST /v1/agents/:id/start` |
| `/stop <name>` | Stop | `POST /v1/agents/:id/stop` |
| `/rebuild <name>` | Rebuild (confirm button) | `POST /v1/agents/:id/rebuild` |
| `/logs <name>` | Tail recent logs (paginated) | `GET /v1/agents/:id/logs` |
| `/members <name>` | List members, each with a Remove button | `GET /v1/agents/:id/members` |
| `/pending` | Pairing requests across the fleet, Approve/Deny buttons | `GET /v1/agents/:id/pairing` |
| `/pool` | Bots free vs used | `GET /v1/pool` |
| `/new` | **Does not create in chat** — replies with a deep link to the web create form | (web) |
| `/delete <name>` | Guarded: confirm button, or deep-link to web | `DELETE /v1/agents/:id` |

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
- editing `SOUL.md` / `MEMORY.md` or multi-field config;
- anything where a 4096-char message or clumsy file upload is the wrong tool.

### Security checklist
- [ ] Strict Telegram-id allowlist, enforced in code before the model runs and
      again in the broker — never via the system prompt.
- [ ] Model holds **no** token and **no** `/v1` access; only typed tool-intents.
- [ ] Tool tiers fixed in the broker: reads auto, mutations human-confirmed,
      secret/irreversible actions not exposed at all.
- [ ] Confirmation cards show the **resolved** target; `callback_data` is an
      opaque single-use short-TTL token (no free-form model text).
- [ ] **No outbound tools** on the management agent — output is only back to you.
- [ ] Broker starts read-only; mutations need an explicit `/mode readwrite`.
- [ ] Fleet content (memory, logs, member names) treated as untrusted input.
- [ ] Token stored encrypted; scoped/labeled; revocable independently.
- [ ] Every proposed and executed action lands in `/v1/events` (audit trail).
- [ ] Rate-limit per chat; ignore edited-message replays of callbacks.
- [ ] Kill switch: a `/pause` that disables the broker instantly.

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
| 2 | **LLM layer** on top of the same broker: natural-language reads/queries/summaries, mutate-by-proposal into the existing confirm gates | days | Conversational management, safely |
| 3 | **SSE stream** + **OpenAPI spec** | ~2 days | Live updates; typed app client |
| 4 | **Native app** + **push relay** | weeks | Polished app, background alerts, secret entry, create/config |
| 5 | **Identity-mode linking** for bot & app | days | Real multi-user |
| 6 | **In-app agent chat** via the gateway bridge | ~week | App becomes chat surface too |

Recommended start: Phase 0 (today), then Phase 1. Build the **broker first with
deterministic commands** — it's the security-critical piece (tiers, confirms,
allowlist), so harden and validate it *before* the LLM in Phase 2, which only
ever *proposes* into gates that already exist. That ordering is the whole point:
the model can grow more capable without ever growing more authority.
