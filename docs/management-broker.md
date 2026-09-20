# Management broker — tool schemas & confirm-token design

Engineering detail behind the hybrid management bot in `control-interfaces.md`.
The broker is the deterministic service between the LLM and `/v1`: it holds the
`cli-token`, exposes a fixed tool set to the model, enforces tiers, and gates
every mutation behind a human confirmation. The model never sees the token and
never reaches `/v1`.

Tools are defined in **Claude tool-use format** (`name` + `input_schema`), since
that's the model interface. Each is wrapped in a **broker manifest entry** that
adds the parts the model must not control: its `tier` and the `/v1` call it maps
to.

---

## 1. Manifest entry shape

```ts
interface BrokerTool {
  tool: {                       // exactly what the model is given
    name: string;
    description: string;
    input_schema: JSONSchema;   // draft 2020-12, additionalProperties:false
  };
  tier: 'read' | 'mutate';      // broker-enforced, NOT in the model's view
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: (input: Resolved) => string;   // built from the RESOLVED action, not raw input
  summary: (r: Resolved) => string;    // human confirmation text for mutate tools
}
```

`tier`, `method`, and `path` live only in the broker. Injected text can influence
what the model *proposes*; it can never change a tool's tier or target endpoint.

---

## 2. Read tools (auto-execute, no confirm)

```jsonc
// list_agents
{
  "name": "list_agents",
  "description": "List the owner's agents with state, model, and last-active time.",
  "input_schema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "state": { "type": "string",
        "enum": ["PROVISIONING","RUNNING","REBUILDING","STOPPED","FAILED"] },
      "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 50 }
    }
  }
}   // → GET /v1/agents  (broker filters by state/limit)

// get_agent
{
  "name": "get_agent",
  "description": "Full status for one agent: state, model, host, members count, pending action.",
  "input_schema": {
    "type": "object", "additionalProperties": false,
    "properties": { "agent": { "$ref": "#/$defs/agentRef" } },
    "required": ["agent"]
  }
}   // → GET /v1/agents/:id

// get_logs
{
  "name": "get_logs",
  "description": "Recent log lines for one agent.",
  "input_schema": {
    "type": "object", "additionalProperties": false,
    "properties": {
      "agent": { "$ref": "#/$defs/agentRef" },
      "lines": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
    },
    "required": ["agent"]
  }
}   // → GET /v1/agents/:id/logs

// list_pending  (pairing requests for ONE agent — `agent` is required;
// the fleet-wide sweep is the notifier's job, via GET /v1/pending)
{
  "name": "list_pending",
  "description": "People waiting to be let into an agent (pairing requests).",
  "input_schema": {
    "type": "object", "additionalProperties": false,
    "properties": { "agent": { "$ref": "#/$defs/agentRef" } },
    "required": ["agent"]
  }
}   // → GET /v1/agents/:id/pairing
```

Also read-tier, same shape: `list_members` (`GET …/members`), `get_pool`
(`GET /v1/pool`), `list_events` (`GET /v1/events`, optional `agent` filter),
`get_health` (`GET …/health`), `get_usage` (`GET …/usage`), and the image
reads `get_runtime` (`GET /v1/runtime`), `list_images` (`GET /v1/images`),
`get_image_log` (`GET /v1/images/:name/log`).

`$defs.agentRef` is shared:

```jsonc
"$defs": {
  "agentRef": {
    "type": "string",
    "description": "An agent id or exact slug from a prior list_agents/get_agent result. Prefer the id.",
    "minLength": 1, "maxLength": 64
  }
}
```

---

## 3. Mutate tools (proposal only — every one requires confirmation)

```jsonc
// stop_agent  (start_agent / rebuild_agent are identical but for name+description)
{
  "name": "stop_agent",
  "description": "Stop a running agent. Requires the owner to confirm.",
  "input_schema": {
    "type": "object", "additionalProperties": false,
    "properties": { "agent": { "$ref": "#/$defs/agentRef" } },
    "required": ["agent"]
  }
}   // tier: mutate → POST /v1/agents/:id/stop

// set_model
{
  "name": "set_model",
  "description": "Set an agent's model. Must be one the agent's AI source offers (the broker validates against the source's menu before any card is shown).",
  "input_schema": {
    "type": "object", "additionalProperties": false,
    "properties": {
      "agent": { "$ref": "#/$defs/agentRef" },
      "model": { "type": "string", "minLength": 1, "maxLength": 64 }
    },
    "required": ["agent","model"]
  }
}   // tier: mutate → PATCH /v1/agents/:id  { model }

// approve_member
{
  "name": "approve_member",
  "description": "Admit a pending pairing request. Reference a request from list_pending.",
  "input_schema": {
    "type": "object", "additionalProperties": false,
    "properties": {
      "agent": { "$ref": "#/$defs/agentRef" },
      "code":  { "type": "string", "pattern": "^[A-Za-z0-9]{4,16}$" }
    },
    "required": ["agent","code"]
  }
}   // tier: mutate → POST /v1/agents/:id/pairing/approve

// remove_member
{
  "name": "remove_member",
  "description": "Remove a member from an agent. Reference a member from list_members.",
  "input_schema": {
    "type": "object", "additionalProperties": false,
    "properties": {
      "agent":  { "$ref": "#/$defs/agentRef" },
      "userId": { "type": "string", "minLength": 1, "maxLength": 128 }
    },
    "required": ["agent","userId"]
  }
}   // tier: mutate → DELETE /v1/agents/:id/members/:userId
```

Image mutates (v0.92.0), same confirm discipline: `build_image` (name +
Dockerfile lines + optional base → `POST /v1/images`; the snippet rides the
card and the FULL lines are posted above it, 10-min authoring TTL; existing
names refused at propose time — use `rebuild_image`), `rebuild_image` (name +
optional newer base → `POST /v1/images/:name/rebuild`), and `remove_image`
(`DELETE /v1/images/:name`; refused BEFORE a card when any agent pins the
image).

**Base-image candidates** (v1.21.0), candidate-first:

- `build_base_candidate`: version, defaulting to the newest on npm →
  `POST /v1/runtime/build {candidate: true}`. It never touches `:latest`, and
  is refused while a build runs or for `latest`/`derived-*` versions.
- `try_base_candidate`: agent + tag → `PATCH image` then rebuild. Only for a
  tag that is built, not the default, and not derived.
- `end_base_trial`: unpin, then rebuild.
- Reads: `list_base_images` and `get_base_build`.
- **Promote is not a tool.** Moving the whole fleet stays a button in the web
  app (Settings → Images). The system prompt tells the model
  to send the owner there, and a test asserts no promote tool exists.

**Forbidden** (never in the tool array — the model literally cannot call them):
`add_ai_key`, set/paste bot token, set password, edit `MEMORY.md`,
`delete_agent`. These return a canned "do this in the web app: <deep-link>".
`delete_agent` may later exist as a mutate tool behind a typed-name double
confirm, but ships absent. (`SOUL.md`/`AGENTS.md` editing graduated from this
list to the confirm-gated authoring tools below — the server snapshots before
every write, so a bad edit is reversible; a poisoned MEMORY.md is not, so
memory stays forbidden.)

---

## 3b. Authoring tools (mutate; one card carries the FULL spec)

`create_agent` and `update_definition` let "define me a stock broker agent
with these template fields" work through the management interface. The shape
that keeps this sound: the model **composes**, the broker **validates**, and a
single confirm-gated proposal card carries the complete spec — name, persona,
full `SOUL.md`/`AGENTS.md` content, setup-field declarations — so one human
tap approves exactly what will exist. The card is a preview; the spec that
executes lives server-side in the pending record, never in Telegram
`callback_data`.

Differences from the verb-shaped mutates:

- **Validation is the control plane's own.** Setup fields are checked with the
  real `TemplateParamSchema` (orchestrator/template.ts), name clashes are
  rejected at propose time, and `update_definition` computes a line-diff stat
  against the LIVE file so the card says how big the change is.
- **Placement is broker-chosen, never model-chosen.** `create_agent` always
  lands on the local host with the AI profile most of the fleet already uses;
  the card shows the owner what was picked.
- **Longer TTL (10 min, not 120 s)** — the owner is reading a document, not a
  verb.
- **Execution is multi-step**: create → wait for RUNNING → write files (each
  write takes the server's pre-edit snapshot) → declare fields. The bot answers
  the button tap immediately and edits the card to "⏳ Working…", because this
  outlives Telegram's callback window. A timeout or FAILED provision reports
  honestly what remains ("still provisioning — propose update_definition once
  RUNNING").

---

## 4. Resolution — turn `agentRef` into a concrete, owned target

Before any tier logic, the broker resolves every `agent` input against **the
owner's fleet only**:

1. exact `id` match (owned) → use it;
2. else exact `slug` match (owned, unique per owner) → use it;
3. else case-insensitive `name` match → if exactly one, use it; if several,
   **reject** with `AMBIGUOUS` listing candidates (never auto-pick for a mutate);
4. else `NOT_FOUND`.

The resolved object — not the raw string — builds the `path`. A hallucinated or
cross-owner id can't reach another account's agent: it simply fails resolution.
`set_model` additionally validates `model ∈ GET /v1/ai-profiles/:id/available-models`
at resolve time and rejects early with the allowed list.

---

## 5. Tool-result envelope (back to the model)

Uniform, so the model always knows what happened — including "not yet":

```jsonc
// read success
{ "ok": true, "tool": "list_agents", "data": [ { "id": "...", "name": "...", "state": "RUNNING", "model": "..." } ] }

// resolution / validation failure  (model relays this to the user)
{ "ok": false, "tool": "stop_agent", "error": { "code": "AMBIGUOUS",
  "message": "3 agents match \"advisor\": Tech Advisor, CMT advisor, Airplane Advisor. Say which id." } }

// mutate: NOT executed — a confirmation was posted to the chat
{ "ok": true, "tool": "stop_agent", "pending": {
  "confirmId": "c_7Gf3kQ2p",
  "summary": "Awaiting your tap to stop \"Tech Advisor\"." } }
```

The `pending` shape is what stops a hijacked model from "believing" it acted:
the mutate result is explicitly *not done yet*.

Error codes: `NOT_FOUND`, `AMBIGUOUS`, `INVALID_INPUT`, `READ_ONLY_MODE`,
`RATE_LIMITED`, `FORBIDDEN_TOOL`, `UPSTREAM_ERROR` (with the `/v1` status).

---

## 6. Confirm token — server-stored, not stuffed into `callback_data`

Telegram `callback_data` is capped at **64 bytes**, far too small for a signed
payload. So the pending action lives server-side, keyed by a short unguessable
id; the button only carries that id:

```
callback_data:  "cfm:c_7Gf3kQ2p:y"      // confirm     (well under 64 bytes)
                "cfm:c_7Gf3kQ2p:n"      // cancel
```

```ts
interface PendingConfirm {
  id: string;            // "c_" + 8 base62 chars from a CSPRNG — unguessable
  ownerId: string;
  chatId: number;        // the Telegram chat that may confirm
  fromUserId: number;    // the allowlisted user who proposed it
  messageId: number;     // the card, edited in place on resolve
  tool: string;          // "stop_agent"
  resolved: Resolved;    // concrete target: { agentId, agentName, ... , model? }
  createdAtMs: number;
  expiresAtMs: number;   // TTL ~120s
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired';
}
```

Why server-stored beats a signed stateless token here: it's **single-use by
construction** (status flips on first resolve), TTL is trivial to enforce, and
the button stays tiny. The id is a capability — random and short-lived — not a
secret to verify.

Since v0.95.0 the web chat pane (control-interfaces.md Phase C) runs a second
instance of this same broker **in-process per owner**: it holds no cli-token —
its ApiClient dispatches through the server's own router carrying the caller's
auth headers — and web confirmations bind to a synthetic proposer
(`chatId 0`) in that session's own PendingStore. Everything below about
single-use/TTL/user-binding applies unchanged.

**Confirm handler (on every callback query):**

```
onCallback(cb):
  [id, verb] = parse("cfm:<id>:<y|n>", cb.data)      # ignore anything malformed
  if cb.from.id not in ALLOWLIST: answer "not allowed"; return
  rec = store.get(id)
  if !rec or rec.status != 'pending': answer "expired or already handled"; return
  if now > rec.expiresAtMs: rec.status='expired'; edit(card,"⌛ expired"); return
  if cb.from.id != rec.fromUserId or cb.message.chat.id != rec.chatId:
        answer "not your confirmation"; return          # cross-chat / cross-user replay
  rec.status = (verb == 'y') ? 'confirmed' : 'cancelled'   # consume: single-use
  store.put(rec)
  if verb == 'n': edit(rec.messageId, "✖ Cancelled"); return
  result = brokerCall(rec.tool, rec.resolved)          # the ONLY place /v1 is hit for mutates
  edit(rec.messageId, result.ok ? "✅ " + rec.summary : "⚠ " + result.error.message)
  audit('mutate.confirmed', rec, result)
```

For AUTHORING tools (v0.95.0) the flow above is DETACHED: the tap is answered
and the card edited to "⏳ Working…" first (proposer-bound peek), then
`brokerCall` runs off the update loop and the card edit is the completion
signal — a confirmed create waits for provisioning (≤150s) and must not block
every other message behind it. The claim is still the synchronous single-use
gate, so a double-tap can't double-run.

Replay, forgery, and confused-deputy are all closed: the id is unguessable and
single-use, TTL-bounded, and bound to the proposing user + chat; a stale or
duplicate callback finds `status != 'pending'` and no-ops.

---

## 7. Policy the broker enforces (independently of the model)

- **Read-only default.** Mutate tools return `READ_ONLY_MODE` until armed.
  (No idle auto-disarm exists yet; arming is manual. Telegram's `/mode
  readwrite` is process-global across its allowlist; the web pane's "Allow
  changes" toggle is per-owner-session.)
- **Rate limit.** One global window over mutate *proposals* (default 20/min);
  `RATE_LIMITED` past the cap. Reads are unmetered.
- **Kill switch.** `/pause` sets a flag that fails every tool at the broker door.
- **Least privilege at the token.** The `cli-token` is owner-scoped; the broker
  narrows further to the tool set — even a compromised broker process can't
  exceed the tool catalog it exposes.
- **Untrusted content.** Read results fed back to the model (member names,
  memory, logs) are data, not instructions — the system prompt says so, length
  caps apply, and every mutate the model is steered into still lands on a
  human-reviewed card whose FULL spec is posted above it (v0.93.0). The tap is
  the enforcement; the prompt is not the boundary.

---

## 8. Audit event

Every proposal and every resolution is logged (reuse `/v1/events` or a broker
table), so "why did it rebuild at 3am" is answerable:

```jsonc
{ "ts": 0, "kind": "mgmt.tool",
  "actor": { "telegramUserId": 1000000001, "ownerId": "user-..." },
  "tool": "stop_agent", "input": { "agent": "tech" },
  "resolved": { "agentId": "169c...", "agentName": "Tech Advisor" },
  "decision": "pending" ,                 // or "executed" | "rejected"
  "confirmId": "c_7Gf3kQ2p",
  "outcome": { "ok": true, "status": 200 } }   // filled on confirm
```

---

## Invariants (the whole design in five lines)

1. The model holds no token and no `/v1` access — only the tool array.
2. `tier`/`method`/`path` are broker state; the prompt is never a boundary.
3. Reads auto-run; every mutate is a server-stored, single-use, TTL'd, user-bound
   confirmation.
4. No outbound tools — the agent's only channel is back to the owner.
5. Resolution is owner-scoped, so ids can't cross accounts and ambiguity never
   auto-resolves a mutation.

## Native tool use on a subscription (v1.23.0)

On a Claude subscription the web chat's model runs through the `claude` CLI.
It used to call tools through a text protocol ("reply with only a JSON
object"), which dropped calls the model wrapped in prose and needed a round
trip per step. Now the CLI is given the assistant's tools as an **MCP server**
(`src/mgmt/mcpServer.mjs`) and runs its own multi-step loop with real tool
use.

- The MCP server holds no authority. Every call goes to
  `POST /v1/mgmt/mcp` with a **one-turn token**: random, held only while that
  chat turn runs, checked in constant time, and accepted only from loopback.
  The same broker decides: reads run, changes become confirmation cards,
  forbidden tools don't exist.
- The token reaches the server through a 0600 config file in the CLI's
  scratch home, which is deleted after the turn, never through argv.
- Containment is unchanged: minimal env, empty scratch cwd, `--tools ""` (no
  built-in tools), `--strict-mcp-config`, and `--allowedTools mcp__hatchabot`.
- `HATCHABOT_MGMT_MCP=0` falls back to the text protocol. The Telegram
  management bot still uses the text protocol, with the tolerant parser from
  v1.22.2.

## Matching the app (v1.24.0)

About 30 more tools, most of them one `/v1` call each, declared as data in
`src/mgmt/restTools.ts`. They cover archive, restore, clone, rename, group,
AI source (with rebuild), class, image pin (with rebuild), scheduled tasks,
peers (with rebuild), Telegram from the pool, invites, memory checkpoints,
snapshots, backups and base-image deletion, plus reads for sources and usage,
tasks, peers, snapshots, backups and classes.

- **Built at propose time, replayed on Confirm.** Each one's call is built
  and checked when the card is proposed: agent references resolve against the
  owner's fleet, source and class names resolve to ids, and peers resolve one
  by one. Confirm replays exactly that call, so the card and the act can't
  differ.
- **The coverage ledger.** `src/mgmt/coverage.ts` marks every route that
  changes something with the chat tool that covers it, or `app: <kind> —
  <reason>`, where the kind is secret, fleet-wide/irreversible, browser,
  internal or later. `test/mgmtCoverage.test.ts` fails when a new route
  arrives unmarked.
