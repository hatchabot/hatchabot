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

// list_pending  (pairing requests; all agents if `agent` omitted)
{
  "name": "list_pending",
  "description": "People waiting to be let into an agent (pairing requests).",
  "input_schema": {
    "type": "object", "additionalProperties": false,
    "properties": { "agent": { "$ref": "#/$defs/agentRef" } }
  }
}   // → GET /v1/agents/:id/pairing  (fan-out if omitted)
```

Also read-tier, same shape: `list_members` (`GET …/members`), `get_pool`
(`GET /v1/pool`), `list_events` (`GET /v1/events`).

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
  "description": "Set an agent's model. Must be one the agent's AI source offers; use list_models first if unsure.",
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
      "code":  { "type": "string", "pattern": "^[A-Za-z0-9]{4,12}$" }
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

**Forbidden** (never in the tool array — the model literally cannot call them):
`add_ai_key`, set/paste bot token, set password, edit `SOUL.md`/`MEMORY.md`,
`delete_agent`. These return a canned "do this in the web app: <deep-link>".
`delete_agent` may later exist as a mutate tool behind a typed-name double
confirm, but ships absent.

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

Replay, forgery, and confused-deputy are all closed: the id is unguessable and
single-use, TTL-bounded, and bound to the proposing user + chat; a stale or
duplicate callback finds `status != 'pending'` and no-ops.

---

## 7. Policy the broker enforces (independently of the model)

- **Read-only default.** Mutate tools return `READ_ONLY_MODE` until an
  allowlisted `/mode readwrite` arms them; auto-disarm after N minutes idle.
- **Rate limits.** Per chat: cap mutate confirmations/minute and total tool
  calls/minute; `RATE_LIMITED` past the cap.
- **Kill switch.** `/pause` sets a flag that fails every tool at the broker door.
- **Least privilege at the token.** The `cli-token` is owner-scoped; the broker
  narrows further to the tool set — even a compromised broker process can't
  exceed the tool catalog it exposes.
- **Untrusted content.** Read results fed back to the model carry member names,
  memory, and logs as data — the broker prefixes such free-text fields with a
  fenced marker and never lets them re-enter as tool arguments unvalidated.

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
