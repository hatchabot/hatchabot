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

### Architecture
A small **command bot** (grammY / node-telegram-bot-api) run as its own process
(a systemd unit beside the control plane, or an OpenClaw-hosted job). It holds
one `cli-token`, long-polls Telegram, and maps commands → `/v1`. **Not** an LLM
agent — control-plane mutations must be deterministic and injection-proof; an
LLM that can be talked into `DELETE /v1/agents/:id` is disqualified from holding
that power.

It needs its own BotFather bot (bots are a hand-minted pool, ~20/account ceiling
— budget one slot), separate from the bots you chat with agents on. Name it
unmistakably (`@MyClawAdminBot`).

### Identity binding
- **Password mode:** an env allowlist of your Telegram id(s); the bot acts as
  the single owner with its token. Trivial.
- **Identity mode:** a linking flow — the web app issues a short code tied to
  your account; you send `/link <code>` to the bot; the bot binds your Telegram
  id → your owner and stores a per-user token. Unlinked ids get nothing.

Every inbound update is checked against the allowlist **before** any API call.

### Command surface

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
- entering **AI API keys, bot tokens, or the app password** (chat isn't a secret
  channel — see `control-interfaces` rationale in the app-question thread);
- editing `SOUL.md` / `MEMORY.md` or multi-field config;
- anything where a 4096-char message or clumsy file upload is the wrong tool.

### Security checklist
- [ ] Strict Telegram-id allowlist, checked on every update and callback.
- [ ] Token stored encrypted; scoped/labeled; revocable independently.
- [ ] Confirmations on destructive actions; no LLM in the mutation path.
- [ ] All actions land in `/v1/events` (audit trail).
- [ ] Rate-limit per chat; ignore edited-message replays of callbacks.

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
| 1 | **Telegram command bot** (password mode): read + lifecycle + approvals + notifications | days | Fast phone ops + push, best value/effort |
| 2 | **SSE stream** + **OpenAPI spec** | ~2 days | Live updates; typed app client |
| 3 | **Native app** + **push relay** | weeks | Polished app, background alerts, secret entry, create/config |
| 4 | **Identity-mode linking** for bot & app | days | Real multi-user |
| 5 | **In-app agent chat** via the gateway bridge | ~week | App becomes chat surface too |

Recommended start: Phase 0 (today), then Phase 1 — the bot delivers the most
utility per unit of work, and Phases 2–3 are the foundations the native app
stands on.
