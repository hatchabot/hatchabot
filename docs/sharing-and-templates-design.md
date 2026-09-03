# Sharing agents & operating templates — design

*Status: Feature 1 (inbox sharing) SHIPPED in v0.84.0. Feature 2 Phase 2a
(placeholder parameters `{{key}}` → SOUL/AGENTS/persona) SHIPPED in v0.87.0 —
declare fields on the agent (📖 Definition → Setup fields, or just hand-write a
`{{placeholder}}`: export auto-derives it as a required text field), the
importer fills a generated form (web file-import and inbox accept; CLI prompts)
and values substitute before the agent boots. Phase 2b `env` targets SHIPPED
(v0.95.0 — see the `target` list below); `datasource:` targets remain design.*

Two requested features, both **extensions of mechanisms that already exist**:

1. **Inbox sharing** — send an agent to another user on this installation, who
   imports it in-app, instead of download → email → import.
2. **Operating templates** — an author defines a few fields (Investment style;
   Gmail account; a Drive/SharePoint link) that are *repopulated* when the agent
   is shared, so each recipient stands up their own configured copy.

## What already exists (the foundation)

- **Template format** (`src/orchestrator/template.ts`): a shareable, secret-free
  copy of an agent — `SOUL.md` + `AGENTS.md` (+ optional `MEMORY.md`), the AI
  vendor, and **declared needs**: `dataNeeds` (data sources it expects) and
  `envNeeds` (env-var *names* the importer supplies). No bot token, no members,
  no history. This is the safety property everything below preserves: *a shared
  artifact never carries the author's secrets.*
- **Import** (`importTemplate`) already stands up a fresh agent owned by the
  importer, and the UI already tells them what to configure (the `needs` hint
  the import route returns and the import dialog shows). Today that's a hint;
  the work below turns it into a guided form.
- **Identity mode is on** (`AGENTCLAW_AUTH=identity`): real accounts with
  `ownerId` + `email`. Five distinct owners already have agents. So "send to a
  user" has real recipients to target.
- **Download/Restore** (`transfer.ts`) is the *other* path — the whole identity,
  for re-hosting the SAME agent. Sharing/templates stay separate from it.

## Feature 1 — Agent inbox (in-app sharing) — SHIPPED v0.84.0

Pure transport change: reuse the template format, deliver it in-app instead of
by email.

**Data**: one table `agent_shares(id, from_owner, from_email, to_email,
to_owner?, agent_name, blob, message, created_at, status)`. `blob` is exactly
the template bytes `shareTemplate` already produces. Stored in the DB, which is
already `chmod 600`.

**API**:
- `POST /v1/agents/:id/send { toEmail, message? }` → build the template, look up
  the recipient's `ownerId` by email (if they've signed in), store a `pending`
  share. If the email isn't a known account yet, hold it keyed by email and bind
  `to_owner` on their first sign-in (same latch pattern as
  `adoptLocalOwnerData`).
- `GET /v1/inbox` → shares addressed to me, `pending`.
- `POST /v1/inbox/:id/accept` → run `importTemplate` on the blob (I become the
  owner, pick my bot the normal way), mark `accepted`.
- `POST /v1/inbox/:id/dismiss`.

**UI**: an inbox badge in the header (count of pending), a dialog listing
incoming agents with sender + message and **Import** / **Dismiss**; a **Send
to…** action on the card (in Share, or the ⋯ menu) that picks a recipient by
email and adds a note.

**Security**: identical to emailing a template — the blob has no secrets, no bot,
no members. The inbox is just a private, in-installation courier. Recipient is
resolved by email; a share to a non-account waits rather than leaking to the
wrong owner. Cap blob size; rate-limit sends.

**Effort**: small-to-medium. No new export/import logic — a table, four
endpoints, an inbox panel.

## Feature 2 — Operating templates (parameters)

Extend the template with a **parameter schema**: typed fields the author defines,
the importer fills, and which are substituted into the new agent's operating
config. This is what makes "define a few items at boot, repopulated on share."

**Parameter definition** (author side), stored on the agent and carried in the
template manifest:

```
parameters: [
  { key, label, help?, required, type, default?, options?, target }
]
```

- `type`: `text` | `longtext` | `choice` | `multichoice` | `boolean`
  (shipped set — `secret`/`url`/`email` from the original design never landed;
  multichoice values are a comma-joined subset of the options)
- `target` — *where the value lands on import*:
  - `soul` / `agents` → substitute a `{{key}}` placeholder the author wrote into
    `SOUL.md` / `AGENTS.md` (the simplest, most flexible form)
  - `env` (SHIPPED, Phase 2b) → the value becomes an agent env var named
    KEY-uppercased: masked entry on the import form, secret into the
    SecretStore before first boot, never stored in `paramValues`, never
    substituted into files; the key must pass the reserved-name policy
    (envPolicy.ts) at declaration. Text type only.
  - `datasource:<mount>.<field>` (future) → fill a data-source config, e.g. a
    Drive/repo URL

**Examples**

- *Stock Advisor*: `investment_style` (choice: value / growth / index → `soul`),
  `risk_tolerance` (text → `soul`). SOUL.md contains "You advise with a
  **{{investment_style}}** philosophy and **{{risk_tolerance}}** risk appetite."
- *Condo Advisor*: `gmail_account` (email → `agents`), `drive_link` (url →
  `datasource:docs.url`), plus the existing `envNeeds` for any token.

**Author UX**: a "Setup fields" section (Settings → Definition) to declare
parameters and write `{{key}}` placeholders into SOUL/AGENTS. A live "unfilled
placeholders" check prevents shipping a template with a `{{key}}` that has no
parameter.

**Import UX**: the current `needs` hint becomes a generated **form** — label +
help + type-appropriate input (secrets masked, choices as a dropdown, url
validated). On submit, values are applied: placeholders substituted in the
seeded files, env targets written encrypted, datasource targets filled. The
agent boots already configured for the importer.

**Security**: the manifest carries parameter *definitions and defaults*, never
the author's filled values — a `secret` parameter is always supplied fresh by
the importer. This keeps the no-secrets guarantee intact. Non-secret answers
(style, a public Drive link) are the importer's own.

**Effort**: medium-to-large. Parameter schema + manifest version bump, author
declaration UI, import form generator, and a small substitution engine
(placeholder / env / datasource).

## How they compose

A parameterized template sent to an inbox is the whole vision in one flow:
*author builds Condo Advisor with `gmail_account` + `drive_link` fields → sends
it to a colleague's inbox → they Import, fill their own email and Drive link →
a working, personalized Condo Advisor boots, on their bot, their account.*

## Recommended sequencing

1. **Inbox sharing** (Phase 1 — DONE, v0.84.0) — small, immediate ("no more
   emailing files"), reuses everything, zero new security surface.
2. **Placeholder parameters** (Phase 2a — DONE, v0.87.0) — `{{key}}` →
   `soul`/`agents` only. The biggest UX win for the least machinery; covers
   Stock Advisor's "investment style" case entirely.
3. **Typed targets** (Phase 2b) — `env:` and `datasource:` parameters, for the
   connection-heavy case (Condo Advisor's Gmail/Drive).

Phase 1 + 2a together deliver the user's stated goals; 2b is the richer
connections layer, best done after the per-agent connection plumbing in
`docs/connections-design.md` lands.
